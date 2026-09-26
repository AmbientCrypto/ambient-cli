import type { AskResponse, NewEvent, ToolContext } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { proposeGoalUpdateTool } from "../src/tools/propose-goal-update.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/w",
    workspaceRoot: "/w",
    signal: new AbortController().signal,
    secret: async () => "",
    emit: () => {},
    scope: { sessionId: "ses_x", turnId: "trn_x", attemptId: "att_x" },
    ...over,
  };
}
const run = (input: { objective: string; reason: string }, c: ToolContext) =>
  proposeGoalUpdateTool.execute(input, c);

const input = { objective: "switch to a Postgres backend", reason: "SQLite won't scale" };

describe("propose_goal_update", () => {
  it("changes nothing (updated:false) when no interactive user is present", async () => {
    const emitted: NewEvent[] = [];
    const res = await run(input, ctx({ ask: undefined, emit: (e) => emitted.push(e) }));
    expect(res.updated).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("emits goal.set with the PROPOSED objective when the user approves", async () => {
    const emitted: NewEvent[] = [];
    const ask = async (): Promise<AskResponse> => ({ selected: ["Use this as the goal"] });
    const res = await run(input, ctx({ ask, emit: (e) => emitted.push(e) }));
    expect(res.updated).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "goal.set", text: "switch to a Postgres backend" });
  });

  it("uses the user's OWN wording (notes) over the proposal when they edit it", async () => {
    const emitted: NewEvent[] = [];
    const ask = async (): Promise<AskResponse> => ({
      selected: ["Use this as the goal"],
      text: "migrate to Postgres AND keep a SQLite dev mode",
    });
    const res = await run(input, ctx({ ask, emit: (e) => emitted.push(e) }));
    expect(res.updated).toBe(true);
    expect(emitted[0]).toMatchObject({
      kind: "goal.set",
      text: "migrate to Postgres AND keep a SQLite dev mode",
    });
  });

  it("does NOT change the goal when the user keeps the current one", async () => {
    const emitted: NewEvent[] = [];
    const ask = async (): Promise<AskResponse> => ({ selected: ["Keep the current goal"] });
    const res = await run(input, ctx({ ask, emit: (e) => emitted.push(e) }));
    expect(res.updated).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("does NOT change the goal when the user dismisses (Esc)", async () => {
    const emitted: NewEvent[] = [];
    const ask = async (): Promise<AskResponse> => ({ selected: [], cancelled: true });
    const res = await run(input, ctx({ ask, emit: (e) => emitted.push(e) }));
    expect(res.updated).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("has zero effects (never gated by the permission ladder — the human's answer gates it)", () => {
    expect(proposeGoalUpdateTool.manifest.effects).toEqual([]);
  });
});
