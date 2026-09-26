import type { AskRequest, ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";

/** Keep a proposed goal tiny (matches the TUI's MAX_GOAL_CHARS) — the reducer caps it again when folded. */
const MAX_GOAL_CHARS = 280;
const APPROVE_LABEL = "Use this as the goal";
const KEEP_LABEL = "Keep the current goal";

const Input = z.object({
  objective: z
    .string()
    .min(1)
    .max(2000)
    .describe("The proposed new north-star objective (one or two plain sentences)"),
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Why the goal should change — what you learned that the current goal doesn't capture",
    ),
});
const Output = z.object({
  answer: z.string(),
  /** True only when the user approved a change (so the model knows the goal actually moved). */
  updated: z.boolean(),
});

/**
 * `propose_goal_update` — the agent SUGGESTS a revised north-star goal; only the USER commits it. This is the
 * fix for the stale-goal trap: as constraints evolve the model can propose an update, but it can never
 * silently rewrite the user's objective. It opens the same confirmation UI as `ask_user`; on approval it
 * records a `goal.set` (the user's own text wins if they edit it in the note field), which updates the pinned
 * goal + every following turn. With no interactive user (headless / subagent child) it changes nothing.
 * No fs/process/network/secret effect — the state change is gated by the human's answer, not the tool.
 */
export const proposeGoalUpdateTool: ToolDefinition<
  z.infer<typeof Input>,
  z.infer<typeof Output>
> = {
  manifest: {
    name: "propose_goal_update",
    version: "1",
    description:
      "Propose a revised north-star goal to the user (they confirm or edit it — you can NEVER change the goal yourself). Use when new constraints make the current goal stale or wrong. Does nothing if the user declines or no interactive user is present.",
    effects: [],
    idempotency: "non-idempotent",
    parallelSafe: false,
    resumability: "never-replay",
    timeoutPolicy: { idleMs: 3_600_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    if (!ctx.ask) {
      return {
        answer:
          "No interactive user is available — the goal is unchanged. Continue toward the current goal and note the constraint you found.",
        updated: false,
      };
    }
    const req: AskRequest = {
      question: `Update the north-star goal?\n\nProposed: ${input.objective}\nWhy: ${input.reason}\n\n(Choose "${APPROVE_LABEL}", or type your own wording in the notes to use that instead.)`,
      options: [{ label: APPROVE_LABEL }, { label: KEEP_LABEL }],
      allowText: true,
      multiSelect: false,
    };
    const res = await ctx.ask(req);
    const approved = res.selected.includes(APPROVE_LABEL);
    if (res.cancelled || !approved) {
      return {
        answer: "The user kept the current goal — it is unchanged. Continue toward it.",
        updated: false,
      };
    }
    // The user's own edit (notes) wins over the proposal; capped to the goal length.
    const next = (res.text?.trim() || input.objective).slice(0, MAX_GOAL_CHARS);
    // Record the user-approved goal durably; the TUI/reducer folds it into the pinned goal + next turn's anchor.
    if (ctx.scope) {
      ctx.emit({ schemaVersion: 1, kind: "goal.set", sessionId: ctx.scope.sessionId, text: next });
    }
    return {
      answer: `The user set the north-star goal to: ${next}. Align to it now.`,
      updated: true,
    };
  },
};
