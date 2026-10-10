import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionId, newTurnId } from "@amb/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionWriter, pendingMessages, readSession, sessionPath } from "../src/index.js";
let dir: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-recovery-"));
  env = { AMB_HOME: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("validates the whole journal while retaining a bounded tail and pending receipts", () => {
  const id = newSessionId();
  const writer = new SessionWriter(id, () => new Date().toISOString(), env);
  const turnId = newTurnId();
  writer.append({
    schemaVersion: 1,
    kind: "session.started",
    sessionId: id,
    cwd: dir,
    workspaceRoot: dir,
  });
  writer.append({
    schemaVersion: 1,
    kind: "turn.started",
    sessionId: id,
    turnId,
    input: "finish the task",
  });
  writer.append({
    schemaVersion: 1,
    kind: "steer.queued",
    sessionId: id,
    messageId: "pending",
    text: "check CI first",
  });
  writer.append({
    schemaVersion: 1,
    kind: "steer.queued",
    sessionId: id,
    messageId: "consumed",
    text: "already read",
  });
  writer.append({
    schemaVersion: 1,
    kind: "steer",
    sessionId: id,
    turnId,
    messageId: "consumed",
    text: "already read",
  });
  for (let n = 0; n < 100; n++)
    writer.append({
      schemaVersion: 1,
      kind: "assistant.final",
      sessionId: id,
      turnId,
      attemptId: "att_test",
      text: `line ${n}`,
    });
  const result = readSession(id, env, { maxEvents: 5, maxBytes: 100_000 });
  expect(result.chainIntact).toBe(true);
  expect(result.events.length).toBeLessThan(12);
  expect(result.events.at(-1)?.seq).toBe(104);
  expect(pendingMessages(result.events).map((message) => message.messageId)).toEqual(["pending"]);
  appendFileSync(sessionPath(id, env), "{torn");
  expect(readSession(id, env, { maxEvents: 5 }).droppedTail).toBe(1);
});
