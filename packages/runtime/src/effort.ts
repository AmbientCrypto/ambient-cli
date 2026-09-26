import type { CatalogModel, Mode } from "@amb/protocol";
import type { EffortSetting, ReasoningLevel } from "./ports.js";

/**
 * Reasoning effort, honest to what Ambient actually serves. Measured live: `none` disables reasoning, `max`
 * reasons roughly twice as deep, and low/medium/high are ONE tier (sent as `high`). Omitting the param
 * reasons by default, so `off` must send an explicit `none`.
 */

/** Hard-work signals in a task → `auto` reasons at max. Stems accept inflections (debug → debugging). */
const HARD_TASK =
  /\b(debug\w*|fix\w*|bugs?|errors?|fail\w*|broken|crash\w*|refactor\w*|optimi[sz]\w*|architect\w*|design\w*|implement\w*|migrat\w*|race condition|regression\w*|investigat\w*|analy[sz]\w*|trac(e|ing)|root ?cause|performance|security|audit\w*|algorithm\w*|concurren\w*)\b/i;
/** Social niceties — nothing to reason about. */
const TRIVIAL_TASK =
  /^\s*(hi|hey|hello|sup|yo|hiya|thanks|thank you|ty|cool|nice|great|got it|test|ping)\b[\s!.?]*$/i;
/** A short go-ahead that continues the work in flight — it should keep the effort that work was using. */
const CONTINUATION =
  /^\s*(ok(ay)?|k|yes|yep|yeah|y|sure|continue|go( ahead| on)?|proceed|do it|yes,? do it|keep going|next)\b[\s!.?]*$/i;

/**
 * The `auto` level for a task. Plan mode and hard work → max; greetings → none; a short go-ahead inherits the
 * previous run's level (so "continue" doesn't drop a long build to a lower tier); everything else → high.
 */
export function autoEffortForTask(
  text: string,
  mode: Mode,
  previous?: ReasoningLevel,
): ReasoningLevel {
  const t = (text ?? "").trim();
  if (TRIVIAL_TASK.test(t)) return "none"; // even in plan mode, a hello needs no reasoning
  if (mode === "plan") return "max";
  if (CONTINUATION.test(t)) return previous ?? "high";
  if (HARD_TASK.test(t)) return "max";
  return "high";
}

/**
 * Resolve the user's effort CHOICE into the `reasoning_effort` to send for THIS request, or undefined to send
 * none. Gated on the served model advertising `reasoning` in the live catalog (never send a param a model
 * doesn't support); resolved per attempt so a failover to a non-reasoning model drops it automatically.
 */
export function resolveEffort(
  setting: EffortSetting | undefined,
  model: CatalogModel | undefined,
  mode: Mode,
  taskEffort?: ReasoningLevel,
): ReasoningLevel | undefined {
  const supportsReasoning = model?.supportedFeatures.includes("reasoning") ?? false;
  if (!supportsReasoning) return undefined;
  const choice = setting ?? "auto";
  if (choice === "off") return "none";
  if (choice === "auto") return taskEffort ?? (mode === "plan" ? "max" : "high");
  return choice;
}

/**
 * Effort for the compaction SUMMARY request: a mechanical extraction on a pay-per-token network, so it never
 * reasons (a max-effort run must not spend reasoning tokens summarizing).
 */
export function summaryEffort(model: CatalogModel | undefined): ReasoningLevel | undefined {
  return (model?.supportedFeatures.includes("reasoning") ?? false) ? "none" : undefined;
}

/**
 * Normalize a user-supplied effort value (flag, config, /effort) to a real setting. Legacy/alias values are
 * accepted and flagged so the caller can say what they map to: low/medium → high, xhigh → max, none → off.
 */
export function normalizeEffortSetting(
  raw: string,
): { setting: EffortSetting; alias: boolean } | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "auto" || v === "off" || v === "high" || v === "max")
    return { setting: v, alias: false };
  if (v === "low" || v === "medium") return { setting: "high", alias: true };
  if (v === "xhigh") return { setting: "max", alias: true };
  if (v === "none") return { setting: "off", alias: true };
  return undefined;
}

/** The choices shown in pickers and help, in order. */
export const EFFORT_SETTINGS: readonly EffortSetting[] = ["auto", "off", "high", "max"];
