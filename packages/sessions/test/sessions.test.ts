import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionId, newTurnId } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionWriter,
  isSafeSessionId,
  readSession,
  sessionPath,
  transcriptText,
} from "../src/index.js";

let home: string;
let env: Record<string, string | undefined>;
const now = () => "2026-09-01T00:00:00.000Z";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "amb-ses-"));
  env = { AMB_HOME: home };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("session-id path safety (no directory escape)", () => {
  it("accepts real minted ids and rejects traversal / separators / absolute paths", () => {
    expect(isSafeSessionId(newSessionId())).toBe(true);
    expect(isSafeSessionId("ses_test-0000")).toBe(true);
    for (const bad of [
      "../secret",
      "../../etc/passwd",
      "a/b",
      "a\\b",
      "/abs",
      "..",
      ".",
      "",
      "a\0b",
    ]) {
      expect(isSafeSessionId(bad)).toBe(false);
    }
  });

  it("sessionPath THROWS on a traversal id instead of resolving outside the sessions dir", () => {
    expect(() => sessionPath("../../evil", env)).toThrow(/invalid session id|escapes/);
    // A safe id resolves inside the sessions dir.
    expect(sessionPath("ses_ok", env)).toContain(join(home, "sessions"));
  });
});

describe("SessionWriter", () => {
  it("stamps, chains, and persists durable events; drops transient ones", () => {
    const sid = newSessionId();
    const w = new SessionWriter(sid, now, env);
    const started = w.append({
      schemaVersion: 1,
      sessionId: sid,
      kind: "session.started",
      cwd: "/ws",
      workspaceRoot: "/ws",
    });
    expect(started?.seq).toBe(0);
    expect(started?.eventId).toMatch(/^evt_/);
    expect(started?.prevChecksum).toBeUndefined();

    const tid = newTurnId();
    const turn = w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      kind: "turn.started",
      input: "hi",
    });
    expect(turn?.seq).toBe(1);
    expect(turn?.prevChecksum).toBe(started?.checksum);

    // transient event returns null and is not persisted
    const transient = w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      attemptId: "att_x-0000",
      kind: "assistant.delta",
      text: "partial",
    } as never);
    expect(transient).toBeNull();

    const { events, chainIntact, droppedTail } = readSession(sid, env);
    expect(events.map((e) => e.kind)).toEqual(["session.started", "turn.started"]);
    expect(chainIntact).toBe(true);
    expect(droppedTail).toBe(0);
  });

  it("tolerates a torn trailing line (crash mid-append)", () => {
    const sid = newSessionId();
    const w = new SessionWriter(sid, now, env);
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      kind: "session.started",
      cwd: "/ws",
      workspaceRoot: "/ws",
    });
    // Simulate a partial write of a second line.
    appendFileSync(sessionPath(sid, env), '{"schemaVersion":1,"kind":"turn.started","inp');
    const res = readSession(sid, env);
    expect(res.events).toHaveLength(1);
    expect(res.droppedTail).toBe(1);
    expect(res.chainIntact).toBe(true);
  });

  it("flags interior corruption (garbage between good records), not just a torn tail", () => {
    const sid = newSessionId();
    const w = new SessionWriter(sid, now, env);
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      kind: "session.started",
      cwd: "/ws",
      workspaceRoot: "/ws",
    });
    // Insert a garbage interior line, then a valid-looking line after it.
    appendFileSync(sessionPath(sid, env), "GARBAGE INTERIOR LINE\n");
    const w2 = new SessionWriter(sid, now, env, 1);
    w2.append({
      schemaVersion: 1,
      sessionId: sid,
      kind: "session.paused",
      reason: "after garbage",
    });
    const res = readSession(sid, env);
    expect(res.interiorCorruption).toBe(true);
    expect(res.chainIntact).toBe(false);
  });

  it("detects a tampered event (broken chain)", () => {
    const sid = newSessionId();
    const w = new SessionWriter(sid, now, env);
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      kind: "session.started",
      cwd: "/ws",
      workspaceRoot: "/ws",
    });
    // Append a hand-forged event whose checksum won't match its content.
    appendFileSync(
      sessionPath(sid, env),
      `${JSON.stringify({ schemaVersion: 1, eventId: "evt_x", sessionId: sid, seq: 1, ts: now(), kind: "session.paused", reason: "forged", checksum: "sha256:bogus" })}\n`,
    );
    expect(readSession(sid, env).chainIntact).toBe(false);
  });
});

describe("reconstructTranscript + turnCount (warm-continue resume)", () => {
  it("rebuilds a readable transcript grouped by turn, including tool activity", async () => {
    const { reconstructTranscript, turnCount } = await import("../src/reader.js");
    const sid = newSessionId();
    const w = new SessionWriter(sid, now, env);
    const tid = newTurnId();
    const aid = "att_r-0000";
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      kind: "session.started",
      cwd: "/ws",
      workspaceRoot: "/ws",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      kind: "turn.started",
      input: "make a.txt",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      attemptId: aid,
      kind: "tool.proposed",
      toolCallId: "tc_1-0000",
      wireId: "call_1",
      toolName: "write",
      args: { path: "a.txt" },
      rawArgs: '{"path":"a.txt"}',
      argsHash: "h",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      attemptId: aid,
      kind: "tool.result",
      toolCallId: "tc_1-0000",
      ok: true,
      durationMs: 5,
      preview: "created",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      kind: "steer",
      text: "also make b.txt",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      attemptId: aid,
      kind: "assistant.final",
      text: "Done.",
    });
    const { events } = readSession(sid, env);
    expect(turnCount(events)).toBe(1);
    const t = reconstructTranscript(events);
    expect(t).toContain("User: make a.txt");
    expect(t).toContain("called write");
    expect(t).toContain("write result: created");
    expect(t).toContain("User (mid-run): also make b.txt"); // a steer survives reconstruction (resume/continuity)
    expect(t).toContain("Assistant: Done.");
    // Tool results pass through the caller's guard (resume wraps them as untrusted data).
    expect(reconstructTranscript(events, (r) => `<<${r}>>`)).toContain("write result: <<created>>");
  });

  it("groups by turnId so interleaved turns don't cross-associate", async () => {
    const { reconstructTranscript } = await import("../src/reader.js");
    const sid = newSessionId();
    const w = new SessionWriter(sid, now, env);
    const a = newTurnId();
    const b = newTurnId();
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      kind: "session.started",
      cwd: "/ws",
      workspaceRoot: "/ws",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: a,
      kind: "turn.started",
      input: "TASK-A",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: b,
      kind: "turn.started",
      input: "TASK-B",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: a,
      attemptId: "att_a-0000",
      kind: "assistant.final",
      text: "ANSWER-A",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: b,
      attemptId: "att_b-0000",
      kind: "assistant.final",
      text: "ANSWER-B",
    });
    const t = reconstructTranscript(readSession(sid, env).events);
    // A's answer must come right after A's task (within A's block), before B's block starts.
    expect(t.indexOf("ANSWER-A")).toBeLessThan(t.indexOf("TASK-B"));
  });
});

describe("transcriptText", () => {
  it("reconstructs the visible transcript from durable events", () => {
    const sid = newSessionId();
    const w = new SessionWriter(sid, now, env);
    const tid = newTurnId();
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      kind: "session.started",
      cwd: "/ws",
      workspaceRoot: "/ws",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      kind: "turn.started",
      input: "build X",
    });
    w.append({
      schemaVersion: 1,
      sessionId: sid,
      turnId: tid,
      attemptId: "att_a-0000",
      kind: "assistant.final",
      text: "done",
    });
    const { events } = readSession(sid, env);
    expect(transcriptText(events)).toBe("> build X\ndone");
  });
});
