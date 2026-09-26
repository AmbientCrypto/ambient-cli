import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel, NewEvent } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import {
  autoEffortForTask,
  normalizeEffortSetting,
  resolveEffort,
  summaryEffort,
} from "../src/effort.js";
import type { ChatClient, ChatParams, RunOptions, TurnCompletion } from "../src/ports.js";

function model(id: string, features: string[], ready = true): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: features,
    supportedSamplingParameters: [],
    contextLength: 262_144,
    maxOutputLength: 262_144,
    isReady: ready,
  };
}

const reasoning = model("re/asoning", ["tools", "reasoning"]);
const plain = model("no/reasoning", ["tools"]);

// Ambient serves THREE real reasoning tiers (measured live): none, high (low/medium/high are identical), max.
// Runtime Mode is plan | ask | accept-edits | bypass (the TUI's "build" maps to the permission axis).
describe("autoEffortForTask — task-adaptive auto effort over the real tiers", () => {
  it("greetings/thanks → none (no reasoning latency on a hello)", () => {
    expect(autoEffortForTask("sup", "ask")).toBe("none");
    expect(autoEffortForTask("hi", "ask")).toBe("none");
    expect(autoEffortForTask("thanks!", "ask")).toBe("none");
  });
  it("hard work → max, including inflected forms the old regex missed", () => {
    expect(autoEffortForTask("fix the failing auth test", "ask")).toBe("max");
    expect(autoEffortForTask("why is this crashing?", "ask")).toBe("max");
    // A plain factual "why" question is ordinary work, not a hard task.
    expect(autoEffortForTask("why is the sky blue? answer in two sentences", "ask")).toBe("high");
    expect(autoEffortForTask("migrate the db layer", "ask")).toBe("max");
    expect(autoEffortForTask("investigating a concurrency issue", "ask")).toBe("max");
    expect(autoEffortForTask("debugging the parser", "ask")).toBe("max");
  });
  it("ordinary tasks → high; plan mode always → max", () => {
    expect(autoEffortForTask("build a 2048 game in react", "ask")).toBe("high");
    expect(autoEffortForTask("list the files", "ask")).toBe("high");
    expect(autoEffortForTask("plan the auth rework", "plan")).toBe("max");
    expect(autoEffortForTask("sup", "plan")).toBe("none");
  });
  it("a short continuation inherits the previous effort instead of dropping", () => {
    expect(autoEffortForTask("continue", "ask", "max")).toBe("max");
    expect(autoEffortForTask("yes do it", "ask", "max")).toBe("max");
    expect(autoEffortForTask("ok", "ask", "high")).toBe("high");
    expect(autoEffortForTask("continue", "ask")).toBe("high");
  });
  it("resolveEffort uses the task level for `auto`, still gated on reasoning support", () => {
    const r = { supportedFeatures: ["reasoning"] } as unknown as CatalogModel;
    const p = { supportedFeatures: [] } as unknown as CatalogModel;
    expect(resolveEffort("auto", r, "ask", "none")).toBe("none");
    expect(resolveEffort("auto", r, "ask", "max")).toBe("max");
    expect(resolveEffort("auto", p, "ask", "max")).toBeUndefined();
  });
});

describe("resolveEffort (pure)", () => {
  it("off sends an explicit none (omitting the param reasons by default on Ambient)", () => {
    expect(resolveEffort("off", reasoning, "bypass")).toBe("none");
  });
  it("defaults an ABSENT setting to auto", () => {
    expect(resolveEffort(undefined, reasoning, "bypass")).toBe("high");
    expect(resolveEffort(undefined, reasoning, "plan")).toBe("max");
  });
  it("passes an explicit level through unchanged (for a reasoning-capable model)", () => {
    expect(resolveEffort("high", reasoning, "ask")).toBe("high");
    expect(resolveEffort("max", reasoning, "ask")).toBe("max");
  });
  it("NEVER sends effort to a model that doesn't advertise `reasoning` (catalog-adaptive)", () => {
    expect(resolveEffort("high", plain, "plan")).toBeUndefined();
    expect(resolveEffort("auto", plain, "plan")).toBeUndefined();
    expect(resolveEffort("off", plain, "ask")).toBeUndefined();
  });
  it("sends nothing when the served model is unknown (absent from the catalog)", () => {
    expect(resolveEffort("high", undefined, "ask")).toBeUndefined();
  });
});

describe("normalizeEffortSetting (legacy + alias values)", () => {
  it("maps legacy low/medium to high and xhigh to max; rejects junk", () => {
    expect(normalizeEffortSetting("low")).toEqual({ setting: "high", alias: true });
    expect(normalizeEffortSetting("medium")).toEqual({ setting: "high", alias: true });
    expect(normalizeEffortSetting("xhigh")).toEqual({ setting: "max", alias: true });
    expect(normalizeEffortSetting("none")).toEqual({ setting: "off", alias: true });
    expect(normalizeEffortSetting("max")).toEqual({ setting: "max", alias: false });
    expect(normalizeEffortSetting("banana")).toBeUndefined();
  });
});

describe("summaryEffort (compaction is a cheap utility task, not the run's effort)", () => {
  it("sends none to a reasoning-capable model (never the run's reasoning tokens)", () => {
    expect(summaryEffort(reasoning)).toBe("none");
  });
  it("sends nothing to a model without the reasoning feature, or an unknown model", () => {
    expect(summaryEffort(plain)).toBeUndefined();
    expect(summaryEffort(undefined)).toBeUndefined();
  });
});

/** Scripted mock that records every ChatParams so we can prove reasoningEffort actually reaches the wire. */
class RecordingClient implements ChatClient {
  public calls: ChatParams[] = [];
  constructor(
    private readonly cat: CatalogModel[],
    private readonly script: TurnCompletion[],
  ) {}
  async fetchCatalog(): Promise<CatalogModel[]> {
    return this.cat;
  }
  async chat(params: ChatParams): Promise<TurnCompletion> {
    this.calls.push(params);
    const next = this.script.shift();
    if (!next) throw new Error("mock script exhausted");
    return next;
  }
}

let ws: string;
const collected: NewEvent[] = [];
const opts = (over: Partial<RunOptions>): RunOptions => ({
  sessionId: "ses_effort-0000",
  mode: "bypass",
  requestedModel: reasoning.id,
  maxTurns: 4,
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  emit: (e) => collected.push(e),
  approve: async () => "deny",
  // Inert workspace — these tests don't exercise instructions/memory (workspace is required in RunOptions).
  workspace: {
    instructions: () => "",
    readMemory: () => undefined,
    writeMemory: () => {},
    date: () => "2026-09-02",
    platform: () => "test",
    skills: () => [],
  },
  ...over,
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-effort-"));
  collected.length = 0;
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("effort reaches the chat client (wired, not just built)", () => {
  it("sends the resolved reasoning_effort for a reasoning-capable served model", async () => {
    const client = new RecordingClient([reasoning], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run("hi", opts({ effort: "high", requestedModel: reasoning.id }));
    expect(client.calls[0]?.reasoningEffort).toBe("high");
  });

  it("auto in plan mode resolves to max on the wire", async () => {
    const client = new RecordingClient([reasoning], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run(
      "plan the new billing flow",
      opts({ effort: "auto", mode: "plan" }),
    );
    expect(client.calls[0]?.reasoningEffort).toBe("max");
  });

  it("auto escalates to max after a failed verification", async () => {
    const client = new RecordingClient(
      [reasoning],
      [
        {
          content: "",
          toolCalls: [
            { id: "tc_w", name: "write", args: { path: "a.txt", content: "x" }, rawArgs: "{}" },
          ],
        },
        { content: "done", toolCalls: [] },
        { content: "fixed", toolCalls: [] },
      ],
    );
    let n = 0;
    await new Agent(client).run(
      "add a feature",
      opts({
        effort: "auto",
        verify: async () =>
          n++ === 0 ? { ok: false, summary: "1 test failed" } : { ok: true, summary: "" },
      }),
    );
    expect(client.calls[0]?.reasoningEffort).toBe("high");
    expect(client.calls[1]?.reasoningEffort).toBe("high");
    expect(client.calls[2]?.reasoningEffort).toBe("max"); // after the failed verification
  });

  it("auto escalates to max after two turns where every tool call failed", async () => {
    const failing = (n: number) => ({
      content: "",
      toolCalls: [
        { id: `tc_${n}`, name: "read", args: { path: `missing-${n}.txt` }, rawArgs: "{}" },
      ],
    });
    const client = new RecordingClient(
      [reasoning],
      [failing(1), failing(2), { content: "done", toolCalls: [] }],
    );
    await new Agent(client).run("add a feature", opts({ effort: "auto" }));
    expect(client.calls[1]?.reasoningEffort).toBe("high");
    expect(client.calls[2]?.reasoningEffort).toBe("max");
  });

  it("sends NOTHING for a model without the reasoning feature, even at effort high", async () => {
    const client = new RecordingClient([plain], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run("hi", opts({ effort: "high", requestedModel: plain.id }));
    expect(client.calls[0]?.reasoningEffort).toBeUndefined();
  });

  it("off sends an explicit none to a reasoning-capable model", async () => {
    const client = new RecordingClient([reasoning], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run("hi", opts({ effort: "off" }));
    expect(client.calls[0]?.reasoningEffort).toBe("none");
  });
});

describe("empty fleet is fatal — the `auto` sentinel never reaches the wire", () => {
  it("errors cleanly and sends NO chat request when the catalog is empty", async () => {
    const client = new RecordingClient([], [{ content: "unused", toolCalls: [] }]);
    const res = await new Agent(client).run("hi", opts({ requestedModel: "auto" }));
    expect(res.stopReason).toBe("error");
    expect(client.calls.length).toBe(0); // never sent "auto" (or anything) to the model
  });
});

describe("denied approvals are the user's choice, not the model struggling", () => {
  it("two batches of denied tool calls do NOT escalate auto effort to max", async () => {
    const denied = (n: number) => ({
      content: "",
      toolCalls: [
        { id: `tc_${n}`, name: "write", args: { path: `f${n}.txt`, content: "x" }, rawArgs: "{}" },
      ],
    });
    const client = new RecordingClient(
      [reasoning],
      [denied(1), denied(2), { content: "ok, stopping", toolCalls: [] }],
    );
    await new Agent(client).run(
      "add a feature",
      opts({ effort: "auto", mode: "ask", approve: async () => "deny" }),
    );
    expect(client.calls[2]?.reasoningEffort).toBe("high");
  });
});
