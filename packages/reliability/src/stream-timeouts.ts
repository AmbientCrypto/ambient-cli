/**
 * Stream watchdog budgets. A decentralized worker can accept a request and then go silent; without a bound the
 * turn hangs until the user notices. Two clocks:
 *  - firstByteMs: from sending the request until the FIRST byte of the body (covers queueing + prefill, so it
 *    grows with the prompt: a 1M-token prefill legitimately takes minutes).
 *  - idleMs: the longest gap allowed between body bytes once streaming has started (SSE keep-alive comments
 *    count as liveness).
 * Deep reasoning can pause visibly longer, so `max` effort gets more room. Both are env-overridable.
 */
export interface StreamTimeouts {
  firstByteMs: number;
  idleMs: number;
}

const FIRST_BYTE_BASE_MS = 90_000;
/** Extra first-byte allowance per 100K prompt tokens (prefill time scales with the prompt). */
const FIRST_BYTE_PER_100K_MS = 60_000;
const FIRST_BYTE_CAP_MS = 15 * 60_000;
const IDLE_BASE_MS = 90_000;
const MAX_EFFORT_FACTOR = 2;

function envMs(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Base first-byte allowance for a model the catalog flags cold (plus the prompt's prefill time): a truly
 *  down worker fails fast, while a big prompt on a flagged-but-serving model still gets time to prefill. */
const FLAGGED_COLD_BASE_MS = 30_000;

export function streamTimeouts(
  req: { promptTokens: number; effort?: string; flaggedCold?: boolean },
  env: Record<string, string | undefined> = process.env,
): StreamTimeouts {
  const deep = req.effort === "max" || req.effort === "xhigh";
  const factor = deep ? MAX_EFFORT_FACTOR : 1;
  const prefill = (Math.max(0, req.promptTokens) / 100_000) * FIRST_BYTE_PER_100K_MS;
  const firstByte = Math.min(FIRST_BYTE_CAP_MS, (FIRST_BYTE_BASE_MS + prefill) * (deep ? 1.5 : 1));
  const firstByteMs = req.flaggedCold
    ? Math.round(Math.min(firstByte, (FLAGGED_COLD_BASE_MS + prefill) * (deep ? 1.5 : 1)))
    : Math.round(firstByte);
  return {
    firstByteMs: envMs(env.AMBIENT_FIRST_BYTE_TIMEOUT_MS) ?? firstByteMs,
    idleMs: envMs(env.AMBIENT_STREAM_IDLE_TIMEOUT_MS) ?? IDLE_BASE_MS * factor,
  };
}

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into milliseconds from `now`.
 * Undefined when absent or unparseable; a date in the past clamps to 0.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const s = header.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - now);
}
