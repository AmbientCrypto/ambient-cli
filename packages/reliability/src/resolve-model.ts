import type { CatalogModel } from "@amb/protocol";
import { type ModelStats, pickBestModel } from "./pick-best.js";
import { readySubstitute } from "./substitution.js";

/**
 * The sentinel that means "pick the best model from the LIVE catalog" — the default when no `--model` is
 * given. NEVER a hard-coded model id: the fleet changes, so the choice is resolved at runtime against the
 * fetched catalog and self-heals when a model goes cold or disappears.
 */
export const AUTO_MODEL = "auto";

/** How a requested model became the model we'll actually serve — the single source of truth for all callers. */
export interface ModelResolution {
  /** What the caller asked for (may be the `auto` sentinel). */
  requested: string;
  /** The concrete model to actually use. */
  target: string;
  rule: "auto-best" | "exact-live" | "ready-substitution" | "unknown-substitution";
  /** A human reason, present only when target !== requested (or when auto-picked). */
  reason?: string;
}

/**
 * Resolve a requested model (or the `auto` sentinel / an empty value) against the live catalog — the ONE
 * place this decision is made, shared by the agent, `chat`, and `route explain` so they can never disagree.
 * Returns `null` when nothing can be served (empty fleet) so callers fail cleanly instead of sending `auto`.
 */
export function resolveRequestedModel(
  requested: string | undefined,
  catalog: CatalogModel[],
  stats?: ModelStats,
): ModelResolution | null {
  if (catalog.length === 0) return null; // empty fleet: nothing can be served (never return a dead target)
  if (requested && requested !== AUTO_MODEL) {
    const target = readySubstitute(requested, catalog) ?? requested;
    if (target === requested) return { requested, target, rule: "exact-live" };
    // Distinguish a KNOWN-but-cold model from an UNKNOWN id (a typo) — both substitute, but calling a typo
    // "cold" is a lie that hides the mistake. `readySubstitute` only substitutes a known model when it's
    // cold, so a substituted id that isn't in the catalog at all is an unknown id.
    const known = catalog.some((m) => m.id === requested);
    return {
      requested,
      target,
      rule: known ? "ready-substitution" : "unknown-substitution",
      reason: known
        ? "requested model is cold; served a warm one"
        : `no model "${requested}" in the fleet; served a live one`,
    };
  }
  const best = pickBestModel(catalog, stats);
  if (!best) return null;
  // Substitute if the best pick is itself cold, so `auto` on a fleet with a cold flagship + a warm peer
  // still resolves to a WARM model (parity with an explicit request's ready-substitution).
  const target = readySubstitute(best, catalog) ?? best;
  return {
    requested: AUTO_MODEL,
    target,
    rule: "auto-best",
    reason: "no model requested; picked the best available from the live fleet",
  };
}
