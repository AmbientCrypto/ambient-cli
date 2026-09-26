import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withGoalReminder } from "../src/agent-support.js";
import { Agent } from "../src/agent.js";
import type { ChatClient, ChatParams, Msg, RunOptions, TurnCompletion } from "../src/ports.js";

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 262_144,
    maxOutputLength: 262_144,
    isReady: true,
  };
}

class RecordingClient implements ChatClient {
  public calls: ChatParams[] = [];
  constructor(private readonly cat: CatalogModel[]) {}
  async fetchCatalog(): Promise<CatalogModel[]> {
    return this.cat;
  }
  async chat(params: ChatParams): Promise<TurnCompletion> {
    this.calls.push(params);
    return { content: "done", toolCalls: [] };
  }
}

const m = model("vendor/m");
let ws: string;
const opts = (over: Partial<RunOptions>): RunOptions => ({
  sessionId: "ses_goal-0000",
  mode: "bypass",
  requestedModel: m.id,
  maxTurns: 2,
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  emit: () => {},
  approve: async () => "deny",
  workspace: {
    instructions: () => "",
    readMemory: () => undefined,
    writeMemory: () => {},
    date: () => "2026-09-04",
    platform: () => "test",
    skills: () => [],
  },
  ...over,
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-goal-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("withGoalReminder (recency half of the sandwich, pure)", () => {
  const base: Msg[] = [
    { role: "system", content: "anchor" },
    { role: "user", content: "do the thing" },
  ];
  it("appends a trailing system reminder carrying the goal, without mutating the input", () => {
    const out = withGoalReminder(base, "ship the export");
    expect(out.length).toBe(base.length + 1);
    expect(base.length).toBe(2); // original untouched
    const last = out[out.length - 1];
    expect(last?.role).toBe("system");
    expect(String(last?.content)).toContain("goal_reminder");
    expect(String(last?.content)).toContain("ship the export");
  });
  it("is a no-op with no goal (returns the same array)", () => {
    expect(withGoalReminder(base, undefined)).toBe(base);
    expect(withGoalReminder(base, "   ")).toBe(base);
  });
});

describe("north-star goal reaches the model (wired, not just built)", () => {
  it("injects the goal into the system message when set", async () => {
    const client = new RecordingClient([m]);
    await new Agent(client).run("hi", opts({ goal: "keep the API backward-compatible" }));
    const sys = client.calls[0]?.messages.find((x) => x.role === "system");
    const text = typeof sys?.content === "string" ? sys.content : "";
    expect(text).toContain("NORTH-STAR GOAL");
    expect(text).toContain("keep the API backward-compatible");
  });

  it("also restates the goal in the LAST message (recency) so weak models keep it in view", async () => {
    const client = new RecordingClient([m]);
    await new Agent(client).run("hi", opts({ goal: "keep the API backward-compatible" }));
    const msgs = client.calls[0]?.messages ?? [];
    const last = msgs[msgs.length - 1];
    expect(String(last?.content)).toContain("goal_reminder");
    expect(String(last?.content)).toContain("keep the API backward-compatible");
  });

  it("sends NO goal block when none is set", async () => {
    const client = new RecordingClient([m]);
    await new Agent(client).run("hi", opts({}));
    const sys = client.calls[0]?.messages.find((x) => x.role === "system");
    const text = typeof sys?.content === "string" ? sys.content : "";
    expect(text).not.toContain("NORTH-STAR GOAL");
  });
});
