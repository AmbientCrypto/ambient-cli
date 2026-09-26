import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";

const Task = z.object({
  text: z
    .string()
    .min(1)
    .max(500)
    .describe("Short imperative description of the step, e.g. 'Add the slugify util'"),
  status: z
    .enum(["pending", "active", "done"])
    .describe("pending | active (in progress now) | done"),
});
const Input = z.object({
  tasks: z
    .array(Task)
    .max(50)
    .describe("The COMPLETE ordered task list — always send the whole list, not a delta"),
});
const Output = z.object({ ok: z.literal(true), count: z.number().int().nonnegative() });

/**
 * The `plan` tool — the model maintains a user-visible task list (like Claude Code's todo list). It is
 * read-only (no filesystem effect, never prompts): the TUI folds the task list from the call and renders
 * it as a pinned checklist. The model calls it up-front with the steps (all `pending`), then again to
 * mark a step `active` when it starts and `done` when finished — always sending the whole list.
 */
export const planTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "plan",
    version: "1",
    description:
      "Maintain a visible task list for the user. Call it at the START of any multi-step task with the steps you intend to take (all status 'pending'). Call it again to set a step 'active' when you begin it and 'done' when it's finished. ALWAYS send the complete ordered list. Keeps the user oriented; has no side effects.",
    effects: ["read"],
    idempotency: "idempotent",
    parallelSafe: false,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 5_000, maximumMs: 5_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, _ctx: ToolContext) {
    return { ok: true as const, count: input.tasks.length };
  },
};
