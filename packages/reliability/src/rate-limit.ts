/**
 * 429 classification + backoff. Clean-room from bridge_policy.py (MIT).
 *
 * A decentralized network returns 429 for two very different reasons:
 *  - "cold": no workers are serving this model right now ⇒ FAIL OVER (retrying the same model is futile).
 *  - "rate_limit": genuine pacing ⇒ back off and retry.
 */

export const BACKOFF_BASE_S = 2;
export const BACKOFF_CAP_S = 30;

export type RateLimitKind = "cold" | "rate_limit";

export function classify429(body: string): RateLimitKind {
  return /no workers are currently available/i.test(body) ? "cold" : "rate_limit";
}

/**
 * Equal-jitter exponential backoff: full = min(cap, base·2^attempt); delay = full/2 + rand·(full/2).
 * `rng` is injectable for deterministic tests.
 */
export function backoffSeconds(attempt: number, rng: () => number = Math.random): number {
  const full = Math.min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** attempt);
  const half = full / 2;
  return half + rng() * half;
}
