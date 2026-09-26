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
    timeoutPolicy: { idleMs: 5_000, maximumMs: 5_000 },
  },
  inputSchema: ReadInput,
  outputSchema: ReadOutput,
  async execute(input, ctx) {
    const r = jobs(ctx).read(input.id);
    // Keep the most recent part when a lot arrived at once (the latest lines are what matter).
    const clipped = r.output.length > MAX_READ;
    return {
      ...r,
      output: clipped ? `…${r.output.slice(-MAX_READ)}` : r.output,
      truncated: r.truncated || clipped,
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
