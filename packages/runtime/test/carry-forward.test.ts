import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions, readMemory, writeMemory } from "@amb/context";
import type { CatalogModel, NewEvent } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flattenNativeToolTurns, sanitizeContinuation } from "../src/agent-support.js";
import { Agent } from "../src/agent.js";
import type {
  CapabilityPort,
  ChatClient,
  ChatParams,
  Msg,
  RunOptions,
  TurnCompletion,
  WorkspaceContextPort,
} from "../src/ports.js";

const testWorkspace = (): WorkspaceContextPort => ({
  instructions: (cwd) => loadInstructions(cwd).text,
  readMemory: (root) => readMemory(root),
  writeMemory: (root, s) => writeMemory(root, s),
  date: () => "2026-09-16",
  platform: () => "test",
  skills: () => [],
});

function model(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 262_144,
    maxOutputLength: 262_144,
    isReady: true,
    ...over,
  };
}

class MockClient implements ChatClient {
  public calls: ChatParams[] = [];
  constructor(
    private readonly catalog: CatalogModel[],
    private readonly script: TurnCompletion[],
  ) {}
  async fetchCatalog(): Promise<CatalogModel[]> {
    return this.catalog;
  }
  async chat(params: ChatParams): Promise<TurnCompletion> {
    // Snapshot the messages as they were AT SEND TIME. The real adapter serializes the request body here, so
    // a later in-loop push to the runtime's live `messages` array must not retroactively change what we saw.
    this.calls.push({ ...params, messages: [...params.messages] });
    const next = this.script.shift();
    if (!next) throw new Error("mock script exhausted");
    return next;
  }
}

let ws: string;
const collected: NewEvent[] = [];
const baseOpts = (over: Partial<RunOptions> = {}): RunOptions => ({
  sessionId: "ses_cf-0000",
  mode: "bypass",
  requestedModel: "vendor/m",
  maxTurns: 6,
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  emit: (e) => collected.push(e),
  approve: async () => "deny",
  workspace: testWorkspace(),
  ...over,
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-cf-"));
  collected.length = 0;
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("interactive conversation carry-forward (long-thread memory)", () => {
  it("run returns the real final messages, and a next run seeded with them SEES the prior turn", async () => {
    const client1 = new MockClient(
      [model("vendor/m")],
      [{ content: "First answer.", toolCalls: [] }],
    );
    const res1 = await new Agent(client1).run("remember X=42", baseOpts());
    expect(res1.stopReason).toBe("complete");
    // [system, user, assistant] — the lossless conversation, not a preview.
    const tail = (res1.messages ?? []).slice(1);
    expect(tail.some((m) => m.role === "user" && m.content === "remember X=42")).toBe(true);
    expect(tail.some((m) => m.role === "assistant" && m.content === "First answer.")).toBe(true);

    // The TUI carries `tail` forward as the next run's priorMessages.
    const client2 = new MockClient([model("vendor/m")], [{ content: "X is 42.", toolCalls: [] }]);
    await new Agent(client2).run("what is X?", baseOpts({ priorMessages: tail }));
    const sent = client2.calls[0]?.messages ?? [];
    expect(sent[0]?.role).toBe("system"); // fresh anchor rebuilt each run
    expect(sent.some((m) => m.role === "user" && m.content === "remember X=42")).toBe(true); // prior user turn
    expect(sent.some((m) => m.role === "assistant" && m.content === "First answer.")).toBe(true); // prior answer
    expect(sent[sent.length - 1]?.content).toBe("what is X?"); // the NEW message is last
  });

  it("prefers the live conversation over the lossy reconstruction — never injects both", async () => {
    const tail: Msg[] = [
      { role: "user", content: "earlier turn" },
      { role: "assistant", content: "earlier answer" },
    ];
    const client = new MockClient([model("vendor/m")], [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "now",
      baseOpts({ priorMessages: tail, resumeContext: "RECON_SHOULD_NOT_APPEAR" }),
    );
    const sys = client.calls[0]?.messages.find((m) => m.role === "system");
    // The reconstruction block is suppressed when we have the real messages (no double-counted history).
    expect(String(sys?.content)).not.toContain("RECON_SHOULD_NOT_APPEAR");
    expect((client.calls[0]?.messages ?? []).some((m) => m.content === "earlier turn")).toBe(true);
  });

  it("still uses the reconstruction on the FIRST run of a resumed session (no live messages)", async () => {
    const client = new MockClient([model("vendor/m")], [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "continue",
      baseOpts({ resumeContext: "PRIOR_SESSION_SUMMARY_XYZ" }),
    );
    const sys = client.calls[0]?.messages.find((m) => m.role === "system");
    expect(String(sys?.content)).toContain("PRIOR_SESSION_SUMMARY_XYZ");
  });
});

describe("plan anchor across interactive messages (adherence)", () => {
  it("sends the outstanding plan with the very first request — before the model re-calls plan", async () => {
    const client = new MockClient([model("vendor/m")], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run(
      "keep going",
      baseOpts({
        plan: {
          tasks: [
            { text: "Wire the parser", status: "active" },
            { text: "Add tests", status: "pending" },
          ],
        },
      }),
    );
    const sent = (client.calls[0]?.messages ?? []).map((m) => String(m.content)).join("\n");
    expect(sent).toContain("## Current plan"); // the checklist is in view from the first turn
    expect(sent).toContain("Wire the parser");
    expect(sent).toContain("Add tests");
    // …but NOT inside the system prompt, which stays a stable, cacheable prefix.
    expect(String(client.calls[0]?.messages[0]?.content)).not.toContain("## Current plan");
  });
});

describe("sanitizeContinuation — a carried conversation is always wire-valid", () => {
  it("trims a dangling tool-call turn whose results were never appended (doom-loop break / cancel)", () => {
    const msgs: Msg[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "bash", args: {}, rawArgs: "{}" }],
      },
    ];
    const out = sanitizeContinuation(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe("do it");
  });

  it("keeps a fully-answered tool-call turn", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "bash", args: {}, rawArgs: "{}" }],
      },
      { role: "tool", toolCallId: "c1", content: "done" },
    ];
    expect(sanitizeContinuation(msgs)).toHaveLength(2);
  });

  it("trims when only SOME of a batch's results are present", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "c1", name: "a", args: {}, rawArgs: "{}" },
          { id: "c2", name: "b", args: {}, rawArgs: "{}" },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "one" },
    ];
    expect(sanitizeContinuation(msgs)).toHaveLength(0);
  });

  it("leaves assisted-lane text turns (no native toolCalls) untouched", () => {
    const msgs: Msg[] = [
      { role: "assistant", content: "I'll run bash" },
      { role: "user", content: "Result of bash: ok" },
    ];
    expect(sanitizeContinuation(msgs)).toHaveLength(2);
  });
});

describe("flattenNativeToolTurns — native tool history is safe for an assisted-lane request", () => {
  it("converts assistant tool_calls + role:tool into plain text (no native tool structure survives)", () => {
    const msgs: Msg[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "on it",
        toolCalls: [{ id: "c1", name: "grep", args: {}, rawArgs: '{"q":"x"}' }],
      },
      { role: "tool", toolCallId: "c1", content: "match at a.ts:1" },
      { role: "assistant", content: "done" },
    ];
    const out = flattenNativeToolTurns(msgs);
    // No message carries native tool structure any more (nothing an assisted/tools:[] request could reject).
    expect(out.every((m) => !m.toolCalls && m.role !== "tool")).toBe(true);
    // The information survives as text so the weak model still has the context.
    expect(
      out.some((m) => typeof m.content === "string" && m.content.includes("called grep")),
    ).toBe(true);
    expect(
      out.some(
        (m) =>
          m.role === "user" &&
          String(m.content).includes("Result of grep") &&
          String(m.content).includes("match at a.ts:1"),
      ),
    ).toBe(true);
    // Plain messages pass through untouched.
    expect(out[0]).toEqual({ role: "user", content: "do it" });
  });
});

describe("cross-lane carry-forward safety (review Finding 1)", () => {
  it("an assisted-lane run NEVER sends native tool_calls, even when the carried history has them", async () => {
    // Message 1 ran on a native model → carried history has assistant.toolCalls + role:tool. Then the user
    // switched to a weak (assisted-lane) model; its request declares no tools, so native tool structure would
    // be an invalid, protocol-contradicting payload.
    const priorNative: Msg[] = [
      { role: "user", content: "earlier" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", args: {}, rawArgs: "{}" }],
      },
      { role: "tool", toolCallId: "c1", content: "FILE_CONTENTS_XYZ" },
      { role: "assistant", content: "read it" },
    ];
    const assistedCaps: CapabilityPort = { laneFor: () => "assisted", learn: () => {} };
    const client = new MockClient([model("weak/m")], [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "continue",
      baseOpts({
        requestedModel: "weak/m",
        priorMessages: priorNative,
        capabilities: assistedCaps,
      }),
    );
    const sent = client.calls[0]?.messages ?? [];
    // No message in the assisted request carries native tool structure.
    expect(sent.every((m) => !m.toolCalls && m.role !== "tool")).toBe(true);
    // …and the earlier tool output is preserved as text so the weak model keeps the context.
    expect(sent.some((m) => String(m.content).includes("FILE_CONTENTS_XYZ"))).toBe(true);
  });
});
