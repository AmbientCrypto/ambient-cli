import type { AskRequest, ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";

const Option = z.object({
  label: z.string().min(1).max(120).describe("A short choice label the user selects"),
  description: z
    .string()
    .max(240)
    .optional()
    .describe("An optional one-line explanation of the choice"),
});
const Input = z.object({
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe("The question to ask the user (one clear decision, phrased plainly)"),
  options: z
    .array(Option)
    .max(8)
    .optional()
    .describe("2–8 selectable choices. Omit for a purely open-ended question."),
  allowText: z
    .boolean()
    .optional()
    .describe(
      "Let the user add free-text context in addition to (or instead of) a choice. Default true.",
    ),
  multiSelect: z
    .boolean()
    .optional()
    .describe("Allow selecting more than one option. Default false."),
});
const Output = z.object({
  /** A human-readable answer string the model reads (selected choices + any free-text, or a proceed note). */
  answer: z.string(),
  /** False when no interactive user was available (headless run) — the model should proceed on best judgment. */
  answered: z.boolean(),
});

/** Format the human's structured response into one plain-English line the model can act on. */
export function formatAnswer(
  req: AskRequest,
  res: {
    selected: string[];
    text?: string;
    cancelled?: boolean;
  },
): string {
  if (res.cancelled) {
    return "The user dismissed the question without answering — proceed using your best judgment.";
  }
  const parts: string[] = [];
  if (res.selected.length > 0) parts.push(`Selected: ${res.selected.join(", ")}`);
  if (res.text && res.text.trim().length > 0) parts.push(`Notes: ${res.text.trim()}`);
  if (parts.length === 0)
    return "The user submitted no selection and no text — proceed using your best judgment.";
  return parts.join(". ");
}

/**
 * The `ask_user` tool — push a STRUCTURED question to the human and await their answer, instead of asking in
 * plain prose and hoping they reply. In the TUI it opens an interactive questionnaire (selectable options +
 * a free-text field); the human's choice + notes come back as the tool result. Use it when you hit a real
 * decision only the user can make (scope, platform, which of N approaches) — not for things you can decide
 * yourself. No side effects. When no interactive user is available (headless run / a subagent child), it
 * returns a "proceed on best judgment" note rather than blocking.
 */
export const askUserTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "ask_user",
    version: "1",
    description:
      "Ask the user a single structured question with selectable options and an optional free-text field, and wait for their answer. Use ONLY for a real decision that needs the user (scope, platform, choosing between approaches) — never for things you can decide yourself. Returns the user's selection + notes.",
    effects: [], // asking a question has no fs/process/network/secret effect — never gated by the permission ladder
    idempotency: "non-idempotent",
    parallelSafe: false,
    resumability: "never-replay",
    // No maximumMs: an interactive answer can take as long as the human needs (only maximumMs is enforced).
    timeoutPolicy: { idleMs: 3_600_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    if (!ctx.ask) {
      return {
        answer:
          "No interactive user is available in this run — proceed using your best judgment and state the assumption you made.",
        answered: false,
      };
    }
    const req: AskRequest = {
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
      allowText: input.allowText ?? true,
      ...(input.multiSelect ? { multiSelect: input.multiSelect } : {}),
    };
    const res = await ctx.ask(req);
    return { answer: formatAnswer(req, res), answered: !res.cancelled };
  },
};
