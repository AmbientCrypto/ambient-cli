/**
 * Per-model EARNED autonomy (Karpathy "autonomy is a slider you earn"). A model that reliably
 * passes the verification gate on the FIRST try has proven it produces working changes — so it earns a
 * higher unattended auto-approve budget; one that frequently ships a broken build earns tighter oversight.
 * Pure + deterministic: verify stats in → an auto-approve cap out. No history yet ⇒ the base cap (neutral).
 */

export interface VerifyStats {
  /** How many times this model reached the verify gate (a completed, file-mutating run). */
  runs: number;
  /** Of those, how many passed verification on the first attempt (no re-ask needed). */
  firstTryPasses: number;
}

/** Enough runs to trust the rate — below this we stay neutral (a lucky/unlucky first run means little). */
export const MIN_RUNS_FOR_TRUST = 3;
/** A floor so even an untrusted model keeps SOME unattended budget (never nags every single edit). */
export const MIN_AUTONOMY_CAP = 5;

/**
 * Scale a base auto-approve cap by a model's verify track record:
 *   ≥80% first-try pass  → 2× (earned more rope)
 *   ≤40% first-try pass  → ½× (sloppy — tighter checkpoints), floored at MIN_AUTONOMY_CAP
 *   otherwise / too few runs → the base cap.
 */
export function autonomyCap(base: number, stats?: VerifyStats): number {
  if (!stats || stats.runs < MIN_RUNS_FOR_TRUST || stats.runs <= 0) return base;
  const rate = stats.firstTryPasses / stats.runs;
  if (rate >= 0.8) return base * 2;
  if (rate <= 0.4) return Math.max(MIN_AUTONOMY_CAP, Math.floor(base / 2));
  return base;
}
