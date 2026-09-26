import { type CatalogModel, supportsVision } from "@amb/protocol";

/**
 * Pick the best default model from the LIVE catalog — never a hard-coded id, so the CLI self-heals as the
 * Ambient fleet changes (a model going cold or disappearing can't strand the default). The catalog carries
 * no explicit "quality" field, so "best" is a small, documented heuristic over the signals it DOES carry:
 *
 *   1. Tool-capable first — a coding agent needs native tool-calls; models without the `tools` feature are
 *      excluded (unless NONE advertise tools, in which case we don't exclude everything).
 *   2. Ready first — prefer `isReady === true`; if nothing is ready (cold start) keep the cold ones so we
 *      still resolve to SOMETHING rather than returning undefined.
 *   3. Capabilities the catalog declares: reasoning support, then context window and output cap
 *      (log-scaled, so a bigger window helps without dominating). Model NAMES are never interpreted — a
 *      model called "code", "flash" or "large" is ranked only by what the catalog says it can do, so a new
 *      model needs no code change. Id order breaks ties deterministically.
 */
/** What real traffic taught us about a model (from the capabilities store); undefined when unknown. */
export type ModelStats = (
  id: string,
) => { okRate?: number; latencyMs?: number; samples?: number } | undefined;

/** Evidence from real requests: a reliable, fast model gains a little; a failing or stalling one loses. Needs
 *  a few samples before it counts, so one bad request doesn't move the ranking. */
export function learnedBonus(stats: ReturnType<ModelStats>): number {
  if (!stats || (stats.samples ?? 0) < 3) return 0;
  const reliability = ((stats.okRate ?? 0.5) - 0.5) * 30; // −15 … +15
  const slowness = Math.min(5, Math.max(0, ((stats.latencyMs ?? 0) - 15_000) / 6_000)); // 0 … −5
  return reliability - slowness;
}

export function pickBestModel(catalog: CatalogModel[], stats?: ModelStats): string | undefined {
  if (catalog.length === 0) return undefined;
  const toolCapable = catalog.filter((m) => m.supportedFeatures.includes("tools"));
  const base = toolCapable.length > 0 ? toolCapable : catalog;
  const ready = base.filter((m) => m.isReady === true);
  const pool = ready.length > 0 ? ready : base;

  return [...pool]
    .map((m) => ({ id: m.id, score: scoreModel(m) + learnedBonus(stats?.(m.id)) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]?.id;
}

/**
 * A PHASE role the fleet can route to (feature #27). Each maps to a per-role scoring overlay on the shared
 * `scoreModel`, so "plan on the strongest reasoner, edit on the best coder, review with a second opinion,
 * compact on a cheap model" all resolve from the SAME live catalog — never a hard-coded id.
 */
export type RoutedRole = "planner" | "executor" | "reviewer" | "compactor";

/** True when the model advertises a finite input or output price (so pricing-based ranking is meaningful). */
function hasPricing(m: CatalogModel): boolean {
  const p = m.pricing;
  return !!p && (Number.isFinite(p.input) || Number.isFinite(p.output));
}
/** A comparable cost figure (input + output price); undefined components count as 0 (a free tier is cheapest). */
function priceOf(m: CatalogModel): number {
  const p = m.pricing;
  return (
    (Number.isFinite(p?.input) ? (p?.input as number) : 0) +
    (Number.isFinite(p?.output) ? (p?.output as number) : 0)
  );
}

/** Per-role score = the shared capability score + a role overlay (all from catalog fields, never names). */
function roleScore(role: RoutedRole, m: CatalogModel): number {
  const base = scoreModel(m);
  if (role === "executor") return base;
  // Planning and reviewing lean harder on reasoning.
  if (role === "planner" || role === "reviewer")
    return base + (m.supportedFeatures.includes("reasoning") ? 25 : 0);
  // Compaction is mechanical: with no pricing to go on, a smaller model (smaller window/output) is the
  // cheaper proxy, and a warm one avoids a cold start.
  return -capacityScore(m) + (m.isReady ? 10 : 0);
}

/**
 * Pick the best LIVE model for a phase role. `executor`/`planner`/`reviewer` require native tool-calls;
 * `compactor` does not (it only has to accept a text summary). `reviewer` prefers a model DIFFERENT from
 * `opts.avoid` (a genuine second opinion) when a comparable warm peer exists, else falls back to it. Returns
 * undefined only for an empty fleet — callers fall back to the run's model, so a role never strands a run.
 */
export function pickForRole(
  role: RoutedRole,
  catalog: CatalogModel[],
  opts: { avoid?: string } = {},
): string | undefined {
  if (catalog.length === 0) return undefined;
  const toolFiltered =
    role === "compactor" ? catalog : catalog.filter((m) => m.supportedFeatures.includes("tools"));
  const base = toolFiltered.length > 0 ? toolFiltered : catalog;
  const ready = base.filter((m) => m.isReady === true);
  const pool = ready.length > 0 ? ready : base;

  // Compaction is pure cost minimization: when the catalog carries PRICING, pick the genuinely cheapest warm
  // model; capability size is only the fallback when no pricing is advertised. The summary always gets the
  // authoritative facts appended, so a weak-but-cheap summarizer is safe.
  if (role === "compactor") {
    const priced = pool.filter((m) => hasPricing(m));
    if (priced.length > 0) {
      return [...priced].sort((a, b) => priceOf(a) - priceOf(b) || a.id.localeCompare(b.id))[0]?.id;
    }
  }

  const scored = [...pool]
    .map((m) => ({ id: m.id, score: roleScore(role, m) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (role === "reviewer" && opts.avoid && scored[0]?.id === opts.avoid && scored.length > 1) {
    return scored[1]?.id; // a second opinion — a different warm model of comparable score
  }
  return scored[0]?.id;
}

/**
 * Whether two catalog ids serve the same model — the same id, or aliases of one model (the catalog lists
 * e.g. `ambient/large` and the model it points at separately, with the same Hugging Face id).
 */
export function sameModel(catalog: CatalogModel[], a: string, b: string): boolean {
  if (a === b) return true;
  const hf = (id: string) => catalog.find((m) => m.id === id)?.huggingFaceId?.toLowerCase();
  const ha = hf(a);
  return ha !== undefined && ha === hf(b);
}

export interface VisionPick {
  id: string;
  /** true = a READY vision model; false = only a COLD vision model exists (caller must NOT fire it — it 429s). */
  ready: boolean;
}

/**
 * Pick the best VISION-capable model from the live catalog (backs the non-vision relay: a blind served model
 * asks this model to describe the image). Vision-capable ⇔ supportsVision (catalog `inputModalities`), never a
 * hardcoded id. Prefers READY; if only cold vision models exist, returns the best with `ready:false` so the
 * caller can degrade honestly instead of firing a cold model. `exclude` drops already-failed peers on failover.
 */
export function pickVisionModel(
  catalog: CatalogModel[],
  opts: { exclude?: ReadonlySet<string> } = {},
): VisionPick | undefined {
  const exclude = opts.exclude ?? new Set<string>();
  const vision = catalog.filter((m) => supportsVision(m) && !exclude.has(m.id));
  if (vision.length === 0) return undefined;
  const ready = vision.filter((m) => m.isReady === true);
  const pool = ready.length > 0 ? ready : vision;
  const best = [...pool]
    .map((m) => ({ id: m.id, score: scoreVisionModel(m) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0];
  return best ? { id: best.id, ready: ready.length > 0 } : undefined;
}

/**
 * Every vision-capable model, best first, for the relay to try in order: ready → unknown → flagged-cold (the
 * readiness flag is a hint; flagged models have been observed serving), score-ordered within each group.
 */
export function rankVisionModels(
  catalog: CatalogModel[],
  opts: { exclude?: ReadonlySet<string> } = {},
): string[] {
  const exclude = opts.exclude ?? new Set<string>();
  const tier = (m: CatalogModel) => (m.isReady === true ? 0 : m.isReady === undefined ? 1 : 2);
  return catalog
    .filter((m) => supportsVision(m) && !exclude.has(m.id))
    .sort(
      (a, b) =>
        tier(a) - tier(b) || scoreVisionModel(b) - scoreVisionModel(a) || a.id.localeCompare(b.id),
    )
    .map((m) => m.id);
}

/** Score a vision model for the relay from its catalog capabilities (window, output cap, reasoning). */
export function scoreVisionModel(m: CatalogModel): number {
  return capacityScore(m) + (m.supportedFeatures.includes("reasoning") ? 5 : 0);
}

/** Size signals the catalog declares: context window and output cap, log-scaled so they help without
 *  dominating (32K ≈ 8, 200K ≈ 18, 1M ≈ 28; output adds up to 6). Missing fields count as small. */
export function capacityScore(m: CatalogModel): number {
  const ctx = m.contextLength ?? 8_192;
  const out = m.maxOutputLength ?? 4_096;
  return (
    Math.min(28, Math.max(0, Math.log2(ctx / 8_192) * 4)) +
    Math.min(6, Math.max(0, Math.log2(out / 4_096) * 1.5))
  );
}

/** Capability score for one model as a default (higher = better): reasoning support + capacity. Pure. */
export function scoreModel(m: CatalogModel): number {
  return (m.supportedFeatures.includes("reasoning") ? 15 : 0) + capacityScore(m);
}
