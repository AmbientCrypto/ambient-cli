import { rememberNote } from "@amb/context";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";

const Input = z.object({
  note: z
    .string()
    .min(1)
    .max(500)
    .describe("A durable fact/decision/preference to remember across sessions (one sentence)"),
});
const Output = z.object({ ok: z.boolean() });

/**
 * The `remember` tool — the model records a deliberate durable note into the project's curated memory
 * (`.ambient/MEMORY.md`), which compounds across sessions and is re-injected as context on the next run.
 *
 * `effects:["write"]`: it DOES write a file (`.ambient/MEMORY.md`), so it is gated by the permission ladder like any
 * other write — PLAN mode (read-only) blocks it, accept-edits/bypass auto-approve it (no path ⇒ no workspace-
 * boundary friction), ask prompts. Declaring it read-only would let it bypass plan mode's read-only guard. The write
 * is best-effort; a failure never aborts the run.
 */
export const rememberTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "remember",
    version: "1",
    description:
      "Record a durable note (a decision, preference, or fact) into project memory so it persists across sessions and is available as context next time. Use it for things worth keeping.",
    effects: ["write"],
    idempotency: "non-idempotent",
    parallelSafe: false,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 5_000, maximumMs: 5_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    return { ok: rememberNote(ctx.workspaceRoot, input.note) };
  },
};
