import type { KeyCandidate } from "../secrets.js";
import type { KeyCheckResult } from "./key-flow.js";

export interface StartupKeyResult {
  result: KeyCheckResult;
  /** A different key on this machine that works, when the current one was rejected. */
  alternative?: KeyCandidate;
  /** Where the rejected key came from (for honest wording). */
  rejected?: KeyCandidate["source"];
}

/**
 * Check the key in use at launch (free — no model runs). When it's rejected, look for another key on this
 * machine that works (e.g. one saved by another Ambient app) and REPORT it — the caller decides whether to
 * switch, so a key the user saves meanwhile always wins.
 */
export async function checkStartupKey(
  current: KeyCandidate,
  candidates: Iterable<KeyCandidate>,
  verify: (key: string) => Promise<KeyCheckResult>,
): Promise<StartupKeyResult> {
  const first = await verify(current.key);
  if (first !== "invalid") return { result: first };
  for (const c of candidates) {
    if (c.key === current.key) continue;
    if ((await verify(c.key)) === "valid")
      return { result: "invalid", alternative: c, rejected: current.source };
  }
  return { result: "invalid", rejected: current.source };
}
