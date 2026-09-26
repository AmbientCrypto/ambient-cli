import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions, readMemory, writeMemory } from "@amb/context";
import type { CatalogModel, NewEvent } from "@amb/protocol";
import { ToolRegistry, createBuiltinRegistry } from "@amb/tools-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatClient, ChatParams, TurnCompletion, WorkspaceContextPort } from "../src/ports.js";
import { type SubagentRole, runSubagents } from "../src/subagent.js";

const catalog: CatalogModel[] = [
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "kimi",
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 262_144,
    maxOutputLength: 262_144,
    isReady: true,
  },
];

class MockClient implements ChatClient {
  public chatCalls = 0;
  constructor(private readonly script: TurnCompletion[]) {}
  async fetchCatalog(): Promise<CatalogModel[]> {
    return catalog;
  }
  async chat(params: ChatParams): Promise<TurnCompletion> {
    this.chatCalls++;
    params.onContent?.("");
    const next = this.script.shift();
    if (!next) throw new Error("mock script exhausted");
    return next;
  }
}

const testWorkspace = (): WorkspaceContextPort => ({
  instructions: (cwd) => loadInstructions(cwd).text,
  readMemory: (root) => readMemory(root),
  writeMemory: (root, s) => writeMemory(root, s),
  date: () => "2026-09-02",
  platform: () => "test",
  skills: () => [],
});

const readOnlyChildRegistry = (_role: SubagentRole): ToolRegistry => {
  const full = createBuiltinRegistry();
  const reg = new ToolRegistry();
  for (const t of full.list()) if (t.manifest.effects.every((e) => e === "read")) reg.register(t);
  return reg;
};

let ws: string;
const emitted: NewEvent[] = [];
const ctx = () => ({
  scope: { sessionId: "ses_parent0", turnId: "trn_parent0", attemptId: "att_parent0" },
  toolCallId: "tc_parent0",
  emit: (e: NewEvent) => emitted.push(e),
  signal: new AbortController().signal,
  cwd: ws,
  workspaceRoot: ws,
});
const deps = () => ({
  client: new MockClient([
    { content: "scout A done", toolCalls: [] },
    { content: "scout B done", toolCalls: [] },
  ]),
  workspace: testWorkspace(),
  approve: async () => "deny" as const,
  parentMode: "ask" as const,
  buildChildRegistry: readOnlyChildRegistry,
  childSink: () => () => {}, // no durable child log in the test
  now: () => 1000,
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-sub-"));
  emitted.length = 0;
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("runSubagents", () => {
  it("spawns a wave, emits subagent.started/finished on the PARENT stream, aggregates summaries", async () => {
    const out = await runSubagents(
      [
        { label: "find-auth", role: "scout", prompt: "find auth" },
        { label: "find-ratelimit", role: "scout", prompt: "find rate limiting" },
      ],
      ctx(),
      deps(),
    );
    const started = emitted.filter((e) => e.kind === "subagent.started");
    const finished = emitted.filter((e) => e.kind === "subagent.finished");
    // A single `subagent.wave` is announced up front (before any child starts) with the EXACT wave size, so
    // the UI knows N immediately and the closing line fires exactly once even for waves > concurrency.
    const waves = emitted.filter((e) => e.kind === "subagent.wave");
    expect(waves).toHaveLength(1);
    expect((waves[0] as { count: number }).count).toBe(2);
    expect(emitted.indexOf(waves[0] as NewEvent)).toBeLessThan(
      emitted.indexOf(started[0] as NewEvent),
    );
    expect(started).toHaveLength(2);
    expect(finished).toHaveLength(2);
    // every subagent event is correlated to the parent tool call
    expect(started.every((e) => (e as { toolCallId: string }).toolCallId === "tc_parent0")).toBe(
      true,
    );
    expect(out.results.map((r) => r.label).sort()).toEqual(["find-auth", "find-ratelimit"]);
    expect(out.summary).toContain("find-auth");
    expect(out.summary).toContain("find-ratelimit");
  });

  it("translates a child's tool activity into subagent.tool events (the visible nested work)", async () => {
    const client = new MockClient([
      {
        content: "",
        toolCalls: [{ id: "tc_c1", name: "list", args: { path: "." }, rawArgs: '{"path":"."}' }],
      },
      { content: "found the file", toolCalls: [] },
    ]);
    const out = await runSubagents([{ label: "s", role: "scout", prompt: "look" }], ctx(), {
      ...deps(),
      client,
    });
    const toolEvents = emitted.filter((e) => e.kind === "subagent.tool");
    // one running + one settled (ok) for the child's `list` call
    expect(toolEvents.map((e) => (e as { status: string }).status)).toEqual(["running", "ok"]);
    expect(toolEvents.every((e) => (e as { toolName: string }).toolName === "list")).toBe(true);
    expect(out.results[0]?.summary).toContain("found the file");
  });

  it("a child NEVER receives the subagent tool (structural depth cap)", () => {
    const reg = readOnlyChildRegistry("builder");
    expect(reg.list().some((t) => t.manifest.name === "subagent")).toBe(false);
  });

  it("routes an `auto` oracle child to a reviewer model; an explicit model overrides routing", async () => {
    const base = (over: Partial<CatalogModel>): CatalogModel => ({
      id: "x",
      name: "x",
      inputModalities: [],
      outputModalities: [],
      supportedFeatures: ["tools"],
      supportedSamplingParameters: [],
      contextLength: 200_000,
      maxOutputLength: 200_000,
      isReady: true,
      ...over,
    });
    const fleet: CatalogModel[] = [
      base({ id: "coder/kimi-code" }),
      base({ id: "think/glm-large", supportedFeatures: ["tools", "reasoning"] }),
    ];
    const models: string[] = [];
    const recordingClient: ChatClient = {
      fetchCatalog: async () => fleet,
      chat: async (p: ChatParams) => {
        models.push(p.model);
        return { content: "reviewed", toolCalls: [] };
      },
    };
    // No model on an oracle → routedRole "reviewer" → the reasoning flagship, not the coder.
    await runSubagents([{ label: "o", role: "oracle", prompt: "review" }], ctx(), {
      ...deps(),
      client: recordingClient,
    });
    expect(models).toContain("think/glm-large");
    expect(models).not.toContain("coder/kimi-code");

    // An explicit model always wins over routing.
    models.length = 0;
    await runSubagents(
      [{ label: "o", role: "oracle", prompt: "review", model: "coder/kimi-code" }],
      ctx(),
      { ...deps(), client: recordingClient },
    );
    expect(models).toEqual(["coder/kimi-code"]);
  });

  it("wires a child's artifact ports to its OWN session store so read_artifact isn't a dead tool", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(ws, "big.txt"), "DATA LINE\n".repeat(20_000)); // forces truncation on a small child window
    const smallFleet: CatalogModel[] = [
      {
        ...(catalog[0] as CatalogModel),
        id: "small/m",
        contextLength: 12_000,
        maxOutputLength: 12_000,
      },
    ];
    const saves: Array<{ session: string; content: string }> = [];
    const blobs = new Map<string, string>();
    const artifactStore = (childSessionId: string) => ({
      save: (content: string) => {
        const h = `art_${saves.length}`;
        saves.push({ session: childSessionId, content });
        blobs.set(h, content);
        return h;
      },
      read: (h: string) => blobs.get(h),
    });
    let sawHandle = false;
    const client: ChatClient = {
      fetchCatalog: async () => smallFleet,
      chat: async (p) => {
        for (const m of p.messages)
          if (
            m.role === "tool" &&
            typeof m.content === "string" &&
            m.content.includes("read_artifact({handle:")
          )
            sawHandle = true;
        return p.messages.some((m) => m.role === "tool")
          ? { content: "done", toolCalls: [] }
          : {
              content: "",
              toolCalls: [
                {
                  id: "tc_r",
                  name: "read",
                  args: { path: "big.txt" },
                  rawArgs: '{"path":"big.txt"}',
                },
              ],
            };
      },
    };
    await runSubagents([{ label: "s", role: "scout", prompt: "read", model: "small/m" }], ctx(), {
      ...deps(),
      client,
      artifactStore,
    });
    expect(saves.length).toBeGreaterThanOrEqual(1); // the child offloaded its big read…
    expect(saves.every((s) => s.session.startsWith("ses_"))).toBe(true); // …to its OWN child session store…
    expect(sawHandle).toBe(true); // …and got a usable read_artifact handle back (tool isn't dead).
  });

  it("serializes concurrent builder approval prompts (no clobber/deadlock of the single-slot approver)", async () => {
    // Two builders, each writes a file → each triggers ONE approve in ask mode. The approver is stateful
    // (a single 'inFlight' slot like the real one); the orchestrator's mutex must keep them from overlapping.
    let inFlight = 0;
    let maxOverlap = 0;
    let asked = 0;
    const approve = async () => {
      inFlight++;
      maxOverlap = Math.max(maxOverlap, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      asked++;
      inFlight--;
      return "allow-once" as const;
    };
    const wspec = (label: string) => ({ label, role: "builder" as const, prompt: "write it" });
    const script = () => [
      {
        content: "",
        toolCalls: [
          {
            id: "tc_w",
            name: "write",
            args: { path: `${Math.random()}.txt`, content: "x\n" },
            rawArgs: "{}",
          },
        ],
      },
      { content: "wrote it", toolCalls: [] },
    ];
    // Each builder needs its own client (shared script would interleave); give the full builtin registry.
    const out = await runSubagents([wspec("b1"), wspec("b2")], ctx(), {
      ...deps(),
      client: new MockClient([...script(), ...script()]),
      parentMode: "ask",
      approve,
      buildChildRegistry: () => createBuiltinRegistry(),
    });
    expect(asked).toBe(2); // both builders asked
    expect(maxOverlap).toBe(1); // serialized — never two prompts open at once
    expect(out.results).toHaveLength(2);
  });
});

describe("a child's questions reach the user", () => {
  it("labelled with the child's name, one at a time", async () => {
    let open = 0;
    let most = 0;
    const questions: string[] = [];
    const ask = async (req: { question: string }) => {
      open++;
      most = Math.max(most, open);
      questions.push(req.question);
      await new Promise((r) => setTimeout(r, 10));
      open--;
      return { answer: "use pnpm", cancelled: false } as never;
    };
    const askCall = {
      content: "",
      toolCalls: [
        { id: "tc_q", name: "ask_user", args: { question: "npm or pnpm?" }, rawArgs: "{}" },
      ],
    };
    const out = await runSubagents(
      [
        { label: "api", role: "builder" as const, prompt: "set up" },
        { label: "ui", role: "builder" as const, prompt: "set up" },
      ],
      ctx(),
      {
        ...deps(),
        client: new MockClient([
          askCall,
          askCall,
          { content: "done", toolCalls: [] },
          { content: "done", toolCalls: [] },
        ]),
        ask: ask as never,
        buildChildRegistry: () => createBuiltinRegistry(),
      },
    );
    expect(out.results).toHaveLength(2);
    expect(questions.sort()).toEqual(["api asks: npm or pnpm?", "ui asks: npm or pnpm?"]);
    expect(most).toBe(1);
  });
});

describe("childWorkspace", () => {
  it("a child can read memory but never writes it", async () => {
    const { childWorkspace } = await import("../src/subagent.js");
    const writes: string[] = [];
    const parent: WorkspaceContextPort = {
      ...testWorkspace(),
      readMemory: () => "parent memory",
      writeMemory: (_r, s) => writes.push(s),
    };
    const child = childWorkspace(parent);
    child.writeMemory("/ws", "child summary");
    expect(writes).toEqual([]);
    expect(child.readMemory("/ws")).toBe("parent memory");
  });
});

describe("subagent budgets", () => {
  it("a child past its soft deadline gets a tool-free WRAP-UP turn and returns partial findings", async () => {
    let calls = 0;
    const slow: ChatClient = {
      fetchCatalog: async () => catalog,
      chat: async (p: ChatParams): Promise<TurnCompletion> => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 40));
        if (p.tools.length === 0)
          return { content: "PARTIAL: auth lives in src/auth.ts", toolCalls: [] };
        return {
          content: "",
          toolCalls: [{ id: `tc_${calls}`, name: "list", args: { path: "." }, rawArgs: "{}" }],
        };
      },
    };
    const out = await runSubagents([{ label: "s", role: "scout", prompt: "look" }], ctx(), {
      ...deps(),
      client: slow,
      timeoutMs: { scout: 60 },
      wrapUpGraceMs: 2_000,
    });
    expect(out.results[0]?.summary).toContain("PARTIAL: auth lives in src/auth.ts");
    expect(out.results[0]?.stopReason).toBe("max_turns");
  });

  it("wraps up and reports as soon as the user asks for it, long before its deadline", async () => {
    let calls = 0;
    let hurry = false;
    const busy: ChatClient = {
      fetchCatalog: async () => catalog,
      chat: async (p: ChatParams): Promise<TurnCompletion> => {
        calls += 1;
        if (calls === 2) hurry = true; // the user pressed Enter while the scout was working
        if (p.tools.length === 0) return { content: "REPORTING EARLY", toolCalls: [] };
        return {
          content: "",
          toolCalls: [
            { id: `tc_${calls}`, name: "list", args: { path: "." }, rawArgs: `{"n":${calls}}` },
          ],
        };
      },
    };
    const started = Date.now();
    const out = await runSubagents([{ label: "s", role: "scout", prompt: "look" }], ctx(), {
      ...deps(),
      client: busy,
      hurry: () => hurry,
    });
    expect(out.results[0]?.summary).toContain("REPORTING EARLY");
    expect(calls).toBeLessThanOrEqual(4);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps a substantial summary (not cut to a few lines)", async () => {
    const long = `FINDINGS ${"detail ".repeat(700)}END`; // ~4.9 KB
    const out = await runSubagents([{ label: "s", role: "scout", prompt: "look" }], ctx(), {
      ...deps(),
      client: new MockClient([{ content: long, toolCalls: [] }]),
    });
    expect(out.results[0]?.summary.length ?? 0).toBeGreaterThanOrEqual(long.length);
  });
});

describe("report size follows the parent's room", () => {
  it("splits the room the parent has for the result evenly across the children", async () => {
    const long = "x".repeat(20_000);
    const d = {
      ...deps(),
      client: new MockClient([
        { content: long, toolCalls: [] },
        { content: long, toolCalls: [] },
      ]),
    };
    const out = await runSubagents(
      [
        { label: "a", role: "scout", prompt: "look" },
        { label: "b", role: "scout", prompt: "look" },
      ],
      { ...ctx(), resultChars: 10_000 },
      d,
    );
    for (const r of out.results) {
      expect(r.summary.length).toBeLessThanOrEqual(5_000 + 200); // half each, plus the truncation note
      expect(r.summary.length).toBeGreaterThan(2_000);
    }
  });
});
