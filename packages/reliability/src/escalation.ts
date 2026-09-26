/** Escalate-on-empty policy. Clean-room from bridge_policy.py (MIT). */

export const ESCALATION_FLOOR = 2048;
export const MAX_ESCALATIONS = 1;

/** Escalate only when the response was empty *because* it was truncated, and we're under the cap. */
export function shouldEscalate(resp: {
  empty: boolean;
  truncated: boolean;
  escalations: number;
}): boolean {
  return resp.empty && resp.truncated && resp.escalations < MAX_ESCALATIONS;
}

/** Double the budget (with a floor), capped to what actually fits: window − prompt − a small margin. */
export function nextMaxTokens(
  current: number,
  opts: { window: number; promptTokens: number },
): number {
  const doubled = Math.max(current * 2, ESCALATION_FLOOR);
  const cap = opts.window - opts.promptTokens - 512;
  return Math.min(doubled, Math.max(0, cap));
}
