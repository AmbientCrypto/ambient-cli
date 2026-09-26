import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CONSECUTIVE_AUTO_APPROVALS } from "@amb/permissions";
import type { NewEvent, ToolDefinition } from "@amb/protocol";
import { ToolRegistry, applyPatchTool, editTool, writeTool } from "@amb/tools-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTools } from "../src/execute-tools.js";
import type { RunOptions, ToolCall } from "../src/ports.js";

let ws: string;
const collected: NewEvent[] = [];
const scope = { sessionId: "ses_x0000", turnId: "trn_x0000", attemptId: "att_x0000" };

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  sessionId: "ses_x0000",
  mode: "bypass", // no approval prompts — we're testing the emission wiring, not the ladder
  requestedModel: "m",
  maxTurns: 8,
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  emit: (e) => collected.push(e),
  approve: async () => "allow-once",
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

/**
 * A tool whose execute() never settles — used to prove the runtime enforces timeoutPolicy. It reuses
 * `write`'s schemas (any valid tool schema works; the point is that execute hangs forever).
 */
const hangTool: ToolDefinition = {
  manifest: {
    name: "hang",
    version: "1",
    description: "never returns",
    effects: ["read"],
    idempotency: "idempotent",
    parallelSafe: false,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 40, maximumMs: 40 },
  },
  inputSchema: writeTool.inputSchema,
  outputSchema: writeTool.outputSchema,
  execute: () => new Promise(() => {}),
};

/** A schema that accepts anything — for lightweight fake tools in the concurrency test. */
const anySchema = {
  safeParse: (v: unknown) => ({ success: true as const, data: v }),
} as unknown as typeof writeTool.inputSchema;

/** A parallel-safe read-only tool that resolves after `ms` — proves results emit on settlement, not in a batch. */
const delayed = (name: string, ms: number): ToolDefinition => ({
  manifest: {
    name,
    version: "1",
    description: name,
    effects: ["read"],
    idempotency: "idempotent",
    parallelSafe: true,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 2_000, maximumMs: 2_000 },
  },
  inputSchema: anySchema,
  outputSchema: anySchema,
  execute: () =>
    ms <= 0
      ? Promise.resolve({ ok: true })
      : new Promise((r) => setTimeout(() => r({ ok: true }), ms)),
});

const registry = (): ToolRegistry =>
  new ToolRegistry()
    .register(writeTool)
    .register(editTool)
    .register(hangTool)
    .register(applyPatchTool);
const call = (name: string, args: unknown): ToolCall => ({
  id: `tc_${name}`,
  name,
  args,
  rawArgs: JSON.stringify(args),
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-exectools-"));
  collected.length = 0;
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("executeTools emission wiring", () => {
  it("a write emits tool.result carrying the unified diff AND a file.mutation record", async () => {
    await executeTools(
      [call("write", { path: "a.ts", content: "hello\n" })],
      registry(),
      opts(),
      scope,
    );
    const result = collected.find((e) => e.kind === "tool.result");
    expect(result).toBeDefined();
    expect((result as { diff?: string }).diff).toContain("+hello");
    const mutation = collected.find((e) => e.kind === "file.mutation");
    expect(mutation).toMatchObject({ path: "a.ts", operation: "create" });
  });

  it("an edit emits file.mutation with operation 'modify'", async () => {
    await executeTools(
      [call("write", { path: "b.ts", content: "1\n" })],
      registry(),
      opts(),
      scope,
    );
    collected.length = 0;
    await executeTools(
      [call("edit", { path: "b.ts", oldString: "1", newString: "2", replaceAll: false })],
      registry(),
      opts(),
      scope,
    );
    const mutation = collected.find((e) => e.kind === "file.mutation");
    expect(mutation).toMatchObject({ path: "b.ts", operation: "modify" });
    const result = collected.find((e) => e.kind === "tool.result");
    expect((result as { diff?: string }).diff).toContain("+2");
  });

  it("apply_patch emits ONE file.mutation per changed file (so amb rewind sees them)", async () => {
    await executeTools(
      [call("write", { path: "a.ts", content: "a1\n" })],
      registry(),
      opts(),
      scope,
    );
    await executeTools(
      [call("write", { path: "b.ts", content: "b1\n" })],
      registry(),
      opts(),
      scope,
    );
    collected.length = 0;
    await executeTools(
      [
        call("apply_patch", {
          edits: [
            { path: "a.ts", oldString: "a1", newString: "a2", replaceAll: false },
            { path: "b.ts", oldString: "b1", newString: "b2", replaceAll: false },
          ],
        }),
      ],
      registry(),
      opts(),
      scope,
    );
    const mutations = collected
      .filter((e) => e.kind === "file.mutation")
      .map((m) => (m as { path: string }).path)
      .sort();
    expect(mutations).toEqual(["a.ts", "b.ts"]); // both files recorded, each with pre/postimage
  });

  it("enforces a tool's timeoutPolicy — a hanging tool becomes an ok:false result, not a stall", async () => {
    const outcomes = await executeTools(
      [call("hang", { path: "h.ts", content: "x" })],
      registry(),
      opts(),
      scope,
    );
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.error).toMatch(/exceeded its 40ms/);
    const result = collected.find((e) => e.kind === "tool.result");
    expect(result).toMatchObject({ ok: false });
  });

  it("emits each tool.result the moment it settles (not batched at the end)", async () => {
    // Two sequential writes (barriers): both results must be present and in call order.
    await executeTools(
      [
        call("write", { path: "x.ts", content: "x\n" }),
        call("write", { path: "y.ts", content: "y\n" }),
      ],
      registry(),
      opts(),
      scope,
    );
    const results = collected.filter((e) => e.kind === "tool.result");
    expect(results).toHaveLength(2);
    const mutations = collected
      .filter((e) => e.kind === "file.mutation")
      .map((m) => (m as { path: string }).path);
    expect(mutations).toEqual(["x.ts", "y.ts"]);
  });

  it("bounds a huge diff at emission (≤ the line cap, with a single honest truncation marker)", async () => {
    const big = `${Array.from({ length: 2000 }, (_, i) => `row ${i}`).join("\n")}\n`;
    await executeTools(
      [call("write", { path: "big.ts", content: big })],
      registry(),
      opts(),
      scope,
    );
    const result = collected.find((e) => e.kind === "tool.result") as { diff?: string };
    const diffLines = (result.diff ?? "").split("\n");
    expect(diffLines.length).toBeLessThanOrEqual(500); // hard ceiling INCLUDING the marker
    expect(result.diff).toContain("diff truncated");
    expect((result.diff ?? "").match(/diff truncated/g)?.length).toBe(1); // exactly one marker
  });

  it("accept-edits forces ONE human checkpoint after the consecutive auto-approve cap", async () => {
    const total = MAX_CONSECUTIVE_AUTO_APPROVALS + 1;
    let asked = 0;
    const autoApproval = { streak: 0 };
    const calls = Array.from({ length: total }, (_, i) =>
      call("write", { path: `w${i}.ts`, content: `${i}\n` }),
    );
    await executeTools(
      calls,
      registry(),
      opts({
        mode: "accept-edits",
        approve: async () => {
          asked++;
          return "allow-once";
        },
      }),
      scope,
      [],
      autoApproval,
    );
    // The first CAP writes auto-approve; only the (CAP+1)th triggers the checkpoint prompt.
    expect(asked).toBe(1);
    // …and the checkpoint reset the streak, so counting restarts from 0.
    expect(autoApproval.streak).toBe(0);
  });

  it("in a PARALLEL batch, a fast tool's result emits before a slow neighbour finishes", async () => {
    const reg = new ToolRegistry().register(delayed("slow", 50)).register(delayed("fast", 0));
    const outcomes = await executeTools([call("slow", {}), call("fast", {})], reg, opts(), scope);
    const resultOrder = collected
      .filter((e) => e.kind === "tool.result")
      .map((e) => (e as { toolCallId: string }).toolCallId);
    // Emission follows SETTLEMENT: fast (index 1) settles first, so its result is emitted first…
    expect(resultOrder[0]).toBe("tc_fast");
    expect(resultOrder[1]).toBe("tc_slow");
    // …but the returned outcomes stay in call-index order for the model-facing transcript.
    expect(outcomes.map((o) => o.toolName)).toEqual(["slow", "fast"]);
  });

  it("runs at most 8 read-only calls from one reply at the same time", async () => {
    let inFlight = 0;
    let peak = 0;
    const counting: ToolDefinition = {
      ...delayed("count", 0),
      execute: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { ok: true };
      },
    };
    const reg = new ToolRegistry().register(counting);
    const calls = Array.from({ length: 20 }, (_, i) => ({
      ...call("count", { i }),
      id: `tc_${i}`,
    }));
    const outcomes = await executeTools(calls, reg, opts(), scope);
    expect(outcomes).toHaveLength(20);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(peak).toBe(8);
  });

  it.skipIf(process.platform === "win32")(
    "a read-only shell command reaching outside the workspace isn't waved through, and an edit via a symlink asks",
    async () => {
      const { symlinkSync, mkdirSync: mk, writeFileSync: wr } = await import("node:fs");
      const { bashTool } = await import("@amb/tools-core");
      const outside = join(ws, "..", `outside-${Date.now()}.txt`);
      wr(outside, "secret\n");
      try {
        wr(join(ws, "README.md"), "hi\n");
        const reg = new ToolRegistry().register(bashTool).register(editTool);
        const [out] = await executeTools(
          [call("bash", { command: `cat ${outside}` })],
          reg,
          opts({ mode: "plan" }),
          scope,
        );
        expect(out?.ok).toBe(false); // plan mode refuses it like any non-read call
        const [inside] = await executeTools(
          [call("bash", { command: "cat README.md" })],
          reg,
          opts({ mode: "plan" }),
          scope,
        );
        expect(inside?.ok).toBe(true);

        mk(join(ws, ".git"));
        wr(join(ws, ".git", "config"), "[core]\n");
        symlinkSync(join(ws, ".git", "config"), join(ws, "notes.txt"));
        let asked = 0;
        await executeTools(
          [call("edit", { path: "notes.txt", oldString: "[core]", newString: "[core]\n\tx = 1" })],
          reg,
          opts({
            mode: "accept-edits",
            approve: async () => {
              asked++;
              return "deny";
            },
          }),
          scope,
        );
        expect(asked).toBe(1);
      } finally {
        rmSync(outside, { force: true });
      }
    },
  );
});
