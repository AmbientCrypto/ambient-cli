import type { CatalogModel } from "@amb/protocol";
import {
  SAFE_MAX_OUTPUT_TOKENS,
  UNKNOWN_OUTPUT,
  UNKNOWN_WINDOW,
  budgetsFor,
  effectiveWindow,
  floorMaxTokens,
} from "@amb/reliability";
import { DEFAULT_BYTES_PER_TOKEN, estimateTokens } from "./tokens.js";

/**
 * Fit an ORDERED list of injected system-context blocks (highest priority first) within a token budget.
 * Only the repo map was budgeted before; instructions/memory/skills/resume landed UNBUDGETED in the
 * never-compacted anchor, so a small-window model could overflow before the task + tools even arrived and be
 * returned "blocked" before turn 1. Earlier blocks keep priority; a block that doesn't fit whole is trimmed to
 * the remaining budget (with a marker) and later blocks are dropped. Large models trim nothing.
 */
const TRIM_MARKER = "\n…(trimmed to fit the model's context window)";

export function fitInjectedBlocks(
  blocks: string[],
  tokenBudget: number,
  bytesPerToken: number = DEFAULT_BYTES_PER_TOKEN,
): string[] {
  const markerCost = estimateTokens(TRIM_MARKER, { bytesPerToken });
  const SEP = 1; // ~1 token for the "\n\n" separator joined between kept blocks
  let remaining = Math.max(0, tokenBudget);
  let anyKept = false;
  return blocks.map((b) => {
    if (!b) return b;
    const sep = anyKept ? SEP : 0;
    const cost = estimateTokens(b, { bytesPerToken }) + sep;
    if (cost <= remaining) {
      remaining -= cost;
      anyKept = true;
      return b;
    }
    // Not enough room for the whole block — truncate to what fits (minus the marker + separator), by BYTES
    // (estimateTokens measures UTF-8 bytes, so a char-slice would overshoot on multibyte content). Drop it
    // entirely if there isn't even room for a token of real content.
    const room = remaining - markerCost - sep;
    if (room <= 1) {
      remaining = 0;
      return "";
    }
    const maxBytes = Math.max(0, Math.floor(room * bytesPerToken));
    const truncated = Buffer.from(b, "utf8").subarray(0, maxBytes).toString("utf8");
    remaining = 0;
    anyKept = true;
    return `${truncated}${TRIM_MARKER}`;
  });
}

/**
 * Per-model token budget. Encodes the CORRECT Ambient budget model:
 *   context_length = SHARED input+output window
 *   max_output_length = a SEPARATE output cap (NOT additive to the window)
 * so the output we send must fit BOTH: it can't exceed max_output_length, and prompt+output can't
 * exceed the (possibly learned-lowered) context window.
 */
export interface ModelBudget {
  model: string;
  contextWindow: number;
  outputCap: number;
}

export const DEFAULT_RESERVE = 1024;

export function budgetFromCatalog(m: CatalogModel, learnedCeiling?: number): ModelBudget {
  // A model that publishes no window is budgeted conservatively (same default as ModelProfile).
  const window =
    effectiveWindow(m.contextLength ?? UNKNOWN_WINDOW, learnedCeiling) ?? UNKNOWN_WINDOW;
  // Same output cap as ModelProfile, so preflight and the agent agree on what a model can return.
  const outputCap = Math.min(m.maxOutputLength ?? UNKNOWN_OUTPUT, SAFE_MAX_OUTPUT_TOKENS, window);
  return { model: m.id, contextWindow: window, outputCap };
}

export interface Preflight {
  model: string;
  contextWindow: number;
  promptEstimate: number;
  reserve: number;
  requestedOutput: number;
  /** The output budget we will actually send as max_tokens. */
  sentOutput: number;
  /** window − prompt − sentOutput; negative signals overflow. */
  remainingShared: number;
  overflow: boolean;
}

/**
 * Compute the output budget to send. sentOutput = clamp(requested, floor, availableForOutput) where
 * availableForOutput = min(outputCap, window − prompt − reserve). Flags overflow when the prompt alone
 * (plus reserve + the floor) can't fit the window.
 */
export function preflight(
  budget: ModelBudget,
  opts: { promptEstimate: number; requestedOutput: number; reserve?: number; reasoning?: boolean },
): Preflight {
  const reserve = opts.reserve ?? DEFAULT_RESERVE;
  const floor = floorMaxTokens(0, { reasoning: opts.reasoning });
  const availableForOutput = Math.min(
    budget.outputCap,
    budget.contextWindow - opts.promptEstimate - reserve,
  );
  const overflow = availableForOutput < floor;
  const sentOutput = overflow
    ? Math.max(0, availableForOutput)
    : Math.min(Math.max(opts.requestedOutput, floor), availableForOutput);
  return {
    model: budget.model,
    contextWindow: budget.contextWindow,
    promptEstimate: opts.promptEstimate,
    reserve,
    requestedOutput: opts.requestedOutput,
    sentOutput,
    remainingShared: budget.contextWindow - opts.promptEstimate - sentOutput,
    overflow,
  };
}

/** ~bytes per token (matches the tokenizer estimate) — converts a token budget into a char budget. */
const CHARS_PER_TOKEN = 3.5;
/** Never below this — a tool result must always show SOMETHING useful. */
const MIN_TOOL_RESULT_CHARS = 1_500;
/** A single tool result may occupy at most this fraction of the REMAINING window. */
const TOOL_RESULT_WINDOW_FRACTION = 0.25;

/**
 * How many CHARS a single tool RESULT may occupy, scaled to the model's REMAINING window — so it compresses
 * HARDER as the conversation fills, and a small-context model gets a tighter cap than a huge one. This is the
 * missing half of context budgeting (the roadmap's input-side ceiling caps the prompt; tool RESULTS are what
 * actually blow the window on small open models).
 */
export function toolResultCharBudget(
  budget: ModelBudget,
  promptTokens: number,
  // The ceiling scales with the model (a 1M-token model can keep far more of one result than a 32K one).
  maxChars: number = budgetsFor(budget.contextWindow, budget.outputCap).toolResultMaxChars,
): number {
  // Normalize non-finite inputs (a NaN prompt estimate must never propagate to a NaN cap).
  const prompt = Number.isFinite(promptTokens) ? promptTokens : 0;
  const window = Number.isFinite(budget.contextWindow) ? budget.contextWindow : 0;
  const remainingTokens = Math.max(0, window - prompt);
  const chars = Math.round(remainingTokens * CHARS_PER_TOKEN * TOOL_RESULT_WINDOW_FRACTION);
  return Math.min(maxChars, Math.max(MIN_TOOL_RESULT_CHARS, chars));
}
