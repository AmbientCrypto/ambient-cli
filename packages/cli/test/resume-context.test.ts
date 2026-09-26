import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionId, newTurnId } from "@amb/protocol";
import { SessionWriter, sessionsDir } from "@amb/sessions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadResumeContext } from "../src/agent/resume-context.js";

let home: string;
let prev: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "amb-resume-"));
  prev = process.env.AMB_HOME;
  process.env.AMB_HOME = home;
});
afterEach(() => {
  if (prev === undefined) Reflect.deleteProperty(process.env, "AMB_HOME");
  else process.env.AMB_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

/** A finished one-turn session in `root`, made `age` seconds old. */
function session(root: string, input: string, age: number, goal?: string): string {
  const id = newSessionId();
  const w = new SessionWriter(id, () => new Date().toISOString());
  w.append({
    schemaVersion: 1,
    kind: "session.started",
    sessionId: id,
    cwd: root,
    workspaceRoot: root,
  });
  if (goal) w.append({ schemaVersion: 1, kind: "goal.set", sessionId: id, text: goal });
  const turnId = newTurnId();
  w.append({ schemaVersion: 1, kind: "turn.started", sessionId: id, turnId, input });
  w.append({
    schemaVersion: 1,
    kind: "turn.finished",
    sessionId: id,
    turnId,
    stopReason: "complete",
  });
  const t = Date.now() / 1000 - age;
  utimesSync(join(sessionsDir(), `${id}.jsonl`), t, t);
  return id;
}

describe("continuing a session", () => {
  it("--continue takes the latest conversation in this folder; latest alone takes the newest anywhere", () => {
    const mine = session("/work/app", "add the login page", 300, "ship login");
    session("/work/other", "unrelated", 10);
    const here = loadResumeContext("latest", { workspaceRoot: "/work/app" });
    if ("error" in here) throw new Error(here.error);
    expect(here.fromSessionId).toBe(mine);
    expect(here.goal).toBe("ship login");
    expect(here.context).toContain("add the login page");
    const anywhere = loadResumeContext("latest");
    if ("error" in anywhere) throw new Error(anywhere.error);
    expect(anywhere.context).toContain("unrelated");
  });

  it("explains when there's nothing to continue", () => {
    expect(loadResumeContext("latest", { workspaceRoot: "/nowhere" })).toEqual({
      error: "no earlier conversation in this folder to continue",
    });
    expect(loadResumeContext("ses_missing")).toEqual({
      error: 'no session "ses_missing" (ambient resume lists them)',
    });
  });
});
