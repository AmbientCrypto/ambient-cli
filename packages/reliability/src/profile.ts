import { type CatalogModel, supportsVision } from "@amb/protocol";
import { effectiveWindow } from "./ceiling.js";

/**
 * ModelProfile — everything the agent needs to know about a model, derived ONLY from its live catalog entry
 * plus what we have learned from real traffic. Every context/output budget in the agent comes from here, so a
 * catalog change (a new 1M-context model, a model gaining vision, a smaller output cap) needs no code change.
 *
 * The numbers below are POLICY (what share of a window to spend on what), never facts about a specific model.
 * Unknown fields fall back to conservative values.
 */

/** Window assumed when the catalog doesn't publish one — small enough to be safe on any real model. */
export const UNKNOWN_WINDOW = 32_768;
/** Output cap assumed when the catalog doesn't publish one. */
export const UNKNOWN_OUTPUT = 8_192;
/** Hard safety ceiling on any single request's output budget, whatever a model advertises. */
export const SAFE_MAX_OUTPUT_TOKENS = 65_536;
/** At or above this window, attached images are sent at full detail (smaller windows get a lighter plan). */
export const HIGH_DETAIL_IMAGE_WINDOW = 200_000;
/** Chars per token for converting token budgets to character budgets (matches the estimator's default). */
const CHARS_PER_TOKEN = 3.5;

export interface ProfileEvidence {
  /** Learned real context ceiling (from a provider overflow) — only ever lowers the catalog window. */
  ceiling?: number;
}

export interface ModelBudgets {
  /** max_tokens to ASK for per turn (the preflight still clamps it to what fits). */
  desiredOutput: number;
  /** Compaction fires when the prompt exceeds window − reserve. */
  compactReserve: number;
  /** Recent tokens kept verbatim when compacting. */
  keepRecent: number;
  /** Most characters a single tool result may keep in context (the rest is offloaded). */
  toolResultMaxChars: number;
  /** Ceiling for the injected repo map (tokens). */
  repoMapMaxTokens: number;
  /** Ceiling for the injected skills index (tokens). */
  skillsMaxTokens: number;
  /** Instruction files (AGENTS.md/CLAUDE.md…): per-file and total character ceilings. */
  instructionsPerFileChars: number;
  instructionsTotalChars: number;
  /** Characters kept from each subagent's report. */
  subagentSummaryChars: number;
  /** Tool schemas from connected servers offered up front; beyond this they're loaded on demand (tokens). */
  toolsOnDemandMaxTokens: number;
}

export interface ModelProfile {
  id: string;
  /** Effective context window (tokens): catalog window, lowered by any learned ceiling. */
  window: number;
  /** Output cap (tokens) from the catalog, bounded by the window and the safety ceiling. */
  outputCap: number;
  vision: boolean;
  /** Every input modality the catalog advertises (text, image, and any future ones). */
  inputModalities: readonly string[];
  /** The catalog DECLARES native tool calling (probed/learned evidence may still override the lane). */
  declaresTools: boolean;
  reasoning: boolean;
  /** Sampling parameters the model accepts; only these are ever sent. Empty ⇒ the catalog didn't say. */
  samplingParams: ReadonlySet<string>;
  /** Catalog readiness (a hint — flagged models have been seen serving). */
  ready: boolean | undefined;
  /** True when the catalog omitted the window/output and conservative defaults were used. */
  estimated: boolean;
  budgets: ModelBudgets;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)));

/** Derive every budget from the window and output cap (pure policy; monotonic in the window). */
export function budgetsFor(window: number, outputCap: number): ModelBudgets {
  const w = Math.max(1, window);
  const desiredOutput = Math.max(1, Math.min(outputCap, clamp(w * 0.1, 8_192, 32_768)));
  const toolResultMaxChars = clamp(w * 0.05 * CHARS_PER_TOKEN, 8_000, 200_000);
  return {
    desiredOutput,
    // Headroom for the next answer plus a tool result, never more than a quarter of the window. The floors
    // yield on a tiny window so reserve + kept history always fit inside it.
    compactReserve: clamp(
      desiredOutput + toolResultMaxChars / CHARS_PER_TOKEN,
      Math.min(2_000, w * 0.25),
      w * 0.25,
    ),
    keepRecent: clamp(w * 0.35, Math.min(4_000, w * 0.35), 350_000),
    toolResultMaxChars,
    repoMapMaxTokens: clamp(w * 0.02, 4_000, 16_000),
    skillsMaxTokens: clamp(w * 0.01, 2_500, 10_000),
    instructionsPerFileChars: clamp(w * 0.02 * CHARS_PER_TOKEN, 4_000, 40_000),
    instructionsTotalChars: clamp(w * 0.06 * CHARS_PER_TOKEN, 12_000, 120_000),
    subagentSummaryChars: clamp(w * 0.02 * CHARS_PER_TOKEN, 4_000, 24_000),
    toolsOnDemandMaxTokens: clamp(w * 0.05, 1_500, 25_000),
  };
}

/** Build the profile for a served model id from its live catalog entry (undefined ⇒ conservative profile). */
export function profileFor(
  id: string,
  model: CatalogModel | undefined,
  evidence: ProfileEvidence = {},
): ModelProfile {
  const estimated = model?.contextLength === undefined || model?.maxOutputLength === undefined;
  const window =
    effectiveWindow(model?.contextLength ?? UNKNOWN_WINDOW, evidence.ceiling) ?? UNKNOWN_WINDOW;
  const outputCap = Math.max(
    1,
    Math.min(model?.maxOutputLength ?? UNKNOWN_OUTPUT, SAFE_MAX_OUTPUT_TOKENS, window),
  );
  const features = (model?.supportedFeatures ?? []).map((f) => f.toLowerCase());
  return {
    id,
    window,
    outputCap,
    vision: model ? supportsVision(model) : false,
    inputModalities: model?.inputModalities ?? ["text"],
    declaresTools: features.some((f) =>
      ["tools", "tool_use", "function_calling", "tool_calls"].includes(f),
    ),
    reasoning: features.includes("reasoning"),
    samplingParams: new Set((model?.supportedSamplingParameters ?? []).map((p) => p.toLowerCase())),
    ready: model?.isReady,
    estimated,
    budgets: budgetsFor(window, outputCap),
  };
}
