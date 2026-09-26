import type { CapabilityProvenance, CatalogModel, Lane } from "@amb/protocol";

/**
 * Capability evidence. A model's ability to reliably drive native tool-calls is established from four
 * sources, in strict precedence: LEARNED (observed in real runs) > PROBED (a dedicated probe) >
 * DECLARED (the catalog's `supported_features`) > ASSUMED (a conservative default). Each fact carries a
 * timestamp + TTL so stale evidence expires and gets re-established.
 */

export type Tri = "yes" | "no" | "unknown";

export interface CapabilityRecord {
  modelId: string;
  /** Does the model reliably emit well-formed native tool calls? */
  toolCalling: Tri;
  provenance: CapabilityProvenance;
  observedAt: number;
  expiresAt: number;
  /** Learned REAL context ceiling (tokens) — set when the model rejected a prompt with a real overflow.
   *  Only ever LOWERS the catalog's optimistic window (never raises it). Persists across sessions. */
  ceiling?: number;
  /** Earned-autonomy record: verify-gate runs this model reached, and how many it passed first-try.
   *  Persists across sessions so a model earns (or loses) unattended budget over time. */
  verifyRuns?: number;
  verifyFirstTryPasses?: number;
  /** Smoothed share of requests to this model that succeeded (0..1), from real traffic. */
  okRate?: number;
  /** Smoothed request latency (ms), from real traffic. */
  latencyMs?: number;
  /** How many request outcomes were observed. */
  samples?: number;
}

export const PROVENANCE_RANK: Record<CapabilityProvenance, number> = {
  learned: 3,
  probed: 2,
  declared: 1,
  assumed: 0,
};

/** Default TTLs (ms): learned/probed facts last a day; declared refreshes with the catalog. */
export const TTL = {
  learned: 24 * 60 * 60 * 1000,
  /** A learned NEGATIVE expires fast: a demotion should be re-tested soon, not pin a model for a day. */
  learnedNo: 2 * 60 * 60 * 1000,
  probed: 24 * 60 * 60 * 1000,
  declared: 60 * 60 * 1000,
  assumed: 60 * 60 * 1000,
} as const;

const TOOL_FEATURE_TOKENS = new Set([
  "tools",
  "tool_use",
  "function_calling",
  "functions",
  "tool_calls",
]);

/** The catalog's declared tool-calling capability (a claim, not proof). */
export function declaredToolCalling(model: CatalogModel): Tri {
  const feats = model.supportedFeatures.map((f) => f.toLowerCase());
  if (feats.some((f) => TOOL_FEATURE_TOKENS.has(f))) return "yes";
  // No feature list at all ⇒ unknown; a non-empty list without a tool token ⇒ "no".
  return feats.length === 0 ? "unknown" : "no";
}

/** Build the declared-provenance record from the catalog (the always-available baseline). */
export function declaredRecord(model: CatalogModel, now: number): CapabilityRecord {
  return {
    modelId: model.id,
    toolCalling: declaredToolCalling(model),
    provenance: "declared",
    observedAt: now,
    expiresAt: now + TTL.declared,
  };
}

/** True if the record is still fresh at `now`. */
export function isFresh(rec: CapabilityRecord, now: number): boolean {
  return rec.expiresAt > now;
}

/**
 * Combine a stored record with the live declared baseline. A fresh higher-provenance record wins;
 * otherwise fall back to declared. Expired stored records are ignored.
 */
export function resolveRecord(
  model: CatalogModel,
  stored: CapabilityRecord | undefined,
  now: number,
): CapabilityRecord {
  const declared = declaredRecord(model, now);
  if (
    stored &&
    isFresh(stored, now) &&
    PROVENANCE_RANK[stored.provenance] >= PROVENANCE_RANK[declared.provenance]
  ) {
    return stored;
  }
  return declared;
}

/**
 * Decide the autonomy lane for a model given its tool-calling evidence. Readiness plays no part: the catalog's
 * flag is only a hint (flagged models have been seen serving), and a model that truly can't serve is handled
 * by failover, not by the lane.
 *  - proven tool-calling (yes) ⇒ `direct`
 *  - proven NOT tool-calling (no) ⇒ `assisted` (controller lane drives it)
 *  - unknown ⇒ `unknown` (try direct first, downgrade on evidence)
 */
export function laneFor(_model: CatalogModel, rec: CapabilityRecord): Lane {
  if (rec.toolCalling === "yes") return "direct";
  if (rec.toolCalling === "no") return "assisted";
  return "unknown";
}

/** Record a learned observation from a real run (native tool-call worked or was malformed). */
export function learnedRecord(modelId: string, worked: boolean, now: number): CapabilityRecord {
  return {
    modelId,
    toolCalling: worked ? "yes" : "no",
    provenance: "learned",
    observedAt: now,
    expiresAt: now + (worked ? TTL.learned : TTL.learnedNo),
  };
}

/** Record a PROBED observation from a dedicated probe run (ranks below learned, above declared). */
export function probedRecord(modelId: string, worked: boolean, now: number): CapabilityRecord {
  return {
    modelId,
    toolCalling: worked ? "yes" : "no",
    provenance: "probed",
    observedAt: now,
    expiresAt: now + TTL.probed,
  };
}
