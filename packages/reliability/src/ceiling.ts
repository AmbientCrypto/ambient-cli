/**
 * Learned context ceilings. Clean-room from ambient-code-bridge/ambient_code/learned.py (MIT).
 *
 * The catalog's declared window can be optimistic. When a model rejects a prompt with a real overflow,
 * we learn a lower effective ceiling for it. A learned ceiling can only ever LOWER the declared limit,
 * never raise it — so a single bad measurement can't inflate the budget.
 */

export function effectiveWindow(
  declared: number | undefined,
  learned?: number,
): number | undefined {
  if (declared === undefined) return learned;
  if (learned === undefined) return declared;
  return Math.min(declared, learned);
}

export function updateLearnedCeiling(prev: number | undefined, observed: number): number {
  return prev === undefined ? observed : Math.min(prev, observed);
}
