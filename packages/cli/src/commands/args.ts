/**
 * Small, shared CLI argument primitives so each command doesn't re-implement (and drift on) the same
 * flag validation. Pure + immutable: each parser returns the validated value OR an `{ error }` object; the
 * command aggregates errors and reports them. Keeps flag semantics identical across run / tui / resume.
 */

import { type EffortSetting, normalizeEffortSetting } from "@amb/runtime";

/** The reasoning-effort choices shown for `--effort` (legacy low/medium/xhigh/none are accepted as aliases). */
export const EFFORT_VALUES = ["auto", "off", "high", "max"] as const;

export interface ParseError {
  error: string;
}

export function isParseError<T>(v: T | ParseError): v is ParseError {
  return typeof v === "object" && v !== null && "error" in v;
}

/**
 * Validate `--effort <level>`. Legacy values still work (low/medium → high, xhigh → max, none → off) and are
 * flagged as aliases so the command can say what they mean on Ambient.
 */
export function parseEffort(
  raw: string | undefined,
): { setting: EffortSetting; alias: boolean } | ParseError {
  const n = normalizeEffortSetting(raw ?? "");
  if (n) return n;
  return { error: `--effort needs one of ${EFFORT_VALUES.join(" / ")} (got ${raw || "nothing"})` };
}

/** One line explaining what an alias maps to (Ambient serves only none/high/max reasoning tiers). */
export function effortAliasNote(raw: string, setting: EffortSetting): string {
  return `effort "${raw}" → ${setting} (Ambient models reason at three real levels: off, high, max)`;
}

/** Validate `--max-turns <n>` as an integer in [1, 1000]. Rejects missing / non-integer / out-of-range. */
export function parseMaxTurns(raw: string | undefined): number | ParseError {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n <= 0 || n > 1000) {
    return { error: `--max-turns needs an integer between 1 and 1000 (got ${raw ?? "nothing"})` };
  }
  return n;
}
