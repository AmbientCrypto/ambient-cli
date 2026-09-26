import type { CatalogModel } from "@amb/protocol";
import { pickBestModel } from "./pick-best.js";

/**
 * Ready/cold model substitution. Clean-room from ambient-code-bridge/ambient_code/catalog_map.py (MIT).
 *
 * When the requested model has vanished from the catalog or is cold (`isReady === false`), pick a warm
 * substitute — prefer the same vendor, then the user default, then any warm model. Return `null` to
 * serve the requested model as-is (it is warm, its readiness is unknown, or nothing is warm).
 *
 * Substitution is NEVER silent at the UX layer: the caller emits a `model.resolved(requested, served)`
 * event and shows the swap.
 */

export interface SubstitutionPrefs {
  defaultModel?: string;
  /**
   * Prefer substitutes matching this predicate (e.g. the same transport lane as the failed request).
   * If ANY warm model matches, the pick is made only among matches; if none match, we fall back to the
   * full warm set so a failover never fails just because no lane-matched model is warm.
   */
  prefer?: (modelId: string) => boolean;
  /** Models never to return (e.g. ones that already failed this turn). */
  exclude?: ReadonlySet<string>;
  /**
   * The catalog's readiness flag is a HINT: flagged-cold models have been observed serving normally. When set
   * (failover — the current model already failed) and nothing is warm, fall back to the best non-excluded
   * flagged model instead of giving up; a real "no workers" 429 still fails over from it.
   */
  attemptCold?: boolean;
}

function vendorOf(id: string): string {
  return id.split("/", 1)[0] ?? id;
}

export function readySubstitute(
  modelId: string,
  catalog: CatalogModel[],
  prefs: SubstitutionPrefs = {},
): string | null {
  const excluded = prefs.exclude ?? new Set<string>();
  const entry = catalog.find((m) => m.id === modelId);
  // Warm (true) or unknown-readiness (undefined) ⇒ serve as-is. Only substitute for cold, vanished or excluded.
  if (entry && entry.isReady !== false && !excluded.has(modelId)) return null;

  const eligible = catalog.filter((m) => m.id !== modelId && !excluded.has(m.id));
  let warmAll = eligible.filter((m) => m.isReady === true);
  if (warmAll.length === 0) {
    // Nothing warm. Initial resolution serves the request as-is; failover tries the flagged-cold rest.
    if (!prefs.attemptCold) return null;
    warmAll = eligible;
    if (warmAll.length === 0) return null;
  }

  // Restrict to lane-matched candidates when the caller asked and any exist; otherwise use all warm.
  const preferred = prefs.prefer ? warmAll.filter((m) => prefs.prefer?.(m.id)) : [];
  const pool = preferred.length > 0 ? preferred : warmAll;

  const vendor = vendorOf(modelId);
  const sameVendor = pool.find((m) => vendorOf(m.id) === vendor);
  if (sameVendor) return sameVendor.id;

  if (prefs.defaultModel !== undefined) {
    const def = pool.find((m) => m.id === prefs.defaultModel);
    if (def) return def.id;
  }
  // Final fallback: the BEST model in the (warm, lane-matched) pool by capability tier — never an arbitrary
  // first-in-catalog-order pick, and never a hard-coded id (self-heals as the fleet changes).
  return pickBestModel(pool) ?? (pool[0] as CatalogModel).id;
}
