import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";

const ReadInput = z.object({
  id: z
    .string()
    .describe("The background command's id (from bash with background: true), e.g. bg1"),
});
const ReadOutput = z.object({
  id: z.string(),
  command: z.string(),
  running: z.boolean(),
  exitCode: z.number().nullable().optional(),
  output: z.string(),
  truncated: z.boolean(),
  reason: z.enum(["output", "exit", "steered", "cancelled", "timeout"]).optional(),
});

const MAX_READ = 30_000;

function jobs(ctx: ToolContext) {
  if (!ctx.backgroundJobs) throw new Error("there are no background commands in this session");
  return ctx.backgroundJobs;
}

/** Read what a background command printed since it was last read. */
export const bashOutputTool: ToolDefinition<
  z.infer<typeof ReadInput>,
  z.infer<typeof ReadOutput>
> = {
  manifest: {
    name: "bash_output",
    version: "1",
    description:
      "Read a background command's new output (since you last read it) and whether it's still running.",
    effects: ["read"],
    idempotency: "non-idempotent",
    parallelSafe: true,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 5_000 },
  },
  inputSchema: ReadInput,
  outputSchema: ReadOutput,
  async execute(input, ctx) {
    const port = jobs(ctx);
    const immediate = port.read(input.id);
    const r =
      immediate.running && (immediate.idleReads ?? 0) >= 2 && port.wait
        ? await port.wait(input.id, {
            until: "output",
            signal: ctx.signal,
            wakeSignal: ctx.waitSignal,
          })
        : immediate;
    // Keep the most recent part when a lot arrived at once (the latest lines are what matter).
    const clipped = r.output.length > MAX_READ;
    const { idleReads: _idle, ...visible } = r;
    return {
      ...visible,
      output: clipped ? `…${r.output.slice(-MAX_READ)}` : r.output,
      truncated: r.truncated || clipped,
    };
  },
};

const WaitInput = ReadInput.extend({
  until: z.enum(["output", "exit"]).default("exit"),
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
});
export const bashWaitTool: ToolDefinition<z.infer<typeof WaitInput>, z.infer<typeof ReadOutput>> = {
  manifest: {
    name: "bash_wait",
    version: "1",
    description:
      "Wait for a background command to finish (default) or print new output. No deadline unless timeoutMs is supplied. Steering interrupts the wait without stopping the command; do not poll bash_output in a loop.",
    effects: ["read"],
    idempotency: "non-idempotent",
    parallelSafe: true,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 60_000 },
  },
  inputSchema: WaitInput,
  outputSchema: ReadOutput,
  async execute(input, ctx) {
    const port = jobs(ctx);
    if (!port.wait) throw new Error("background waiting is unavailable in this session");
    const result = await port.wait(input.id, {
      ...input,
      signal: ctx.signal,
      wakeSignal: ctx.waitSignal,
    });
    const clipped = result.output.length > MAX_READ;
    const { idleReads: _idle, ...visible } = result;
    return {
      ...visible,
      output: clipped ? `…${result.output.slice(-MAX_READ)}` : result.output,
      truncated: result.truncated || clipped,
    };
  },
};

const KillInput = z.object({ id: z.string().describe("The background command's id, e.g. bg1") });
const KillOutput = z.object({ id: z.string(), stopped: z.boolean() });

/** Stop a background command and everything it started. */
export const killShellTool: ToolDefinition<
  z.infer<typeof KillInput>,
  z.infer<typeof KillOutput>
> = {
  manifest: {
    name: "kill_shell",
    version: "1",
    description: "Stop a background command (and anything it started).",
    effects: ["process"],
    idempotency: "idempotent",
    parallelSafe: false,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 10_000, maximumMs: 10_000 },
  },
  inputSchema: KillInput,
  outputSchema: KillOutput,
  async execute(input, ctx) {
    return { id: input.id, stopped: jobs(ctx).kill(input.id) };
  },
};
