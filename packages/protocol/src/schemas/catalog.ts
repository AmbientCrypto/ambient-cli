import { z } from "zod";

/**
 * Readiness decoding. Verified semantics: `is_ready:false` ⇒ immediate 429 "No workers are currently
 * available" (cold); retrying does not warm it. We recognize explicit true/false tokens only — an
 * unrecognized value is UNKNOWN (undefined), never optimistically "ready".
 */
const TRUE_TOKENS = new Set(["true", "1", "yes", "ready", "on", "warm", "available"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "off", "cold", "unavailable"]);

export function decodeReadiness(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isNaN(v) ? undefined : v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "") return undefined;
    if (TRUE_TOKENS.has(s)) return true;
    if (FALSE_TOKENS.has(s)) return false;
    return undefined;
  }
  return undefined;
}

/** Tolerant list: a scalar string becomes a single-element array; junk becomes undefined. */
const zStrList = z
  .preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string()))
  .optional()
  .catch(undefined);

/** Tolerant positive int: accepts stringified integers; junk becomes undefined. */
const zPosInt = z.coerce.number().int().positive().optional().catch(undefined);
const zNum = z.coerce.number().optional().catch(undefined);

export const PricingSchema = z
  .object({ input: zNum, output: zNum, cache_read: zNum, cache_write: zNum })
  .partial()
  .optional()
  .catch(undefined);
export type Pricing = z.infer<typeof PricingSchema>;

/** Raw record from GET /v1/models (snake_case, tolerant). Unknown keys are stripped. */
/** An optional text field: null or a wrong type reads as absent instead of rejecting the whole model. */
const zOptStr = z.string().optional().catch(undefined);

export const RawCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: zOptStr,
  description: zOptStr,
  input_modalities: zStrList,
  output_modalities: zStrList,
  context_length: zPosInt,
  max_output_length: zPosInt,
  supported_features: zStrList,
  supported_sampling_parameters: zStrList,
  hugging_face_id: zOptStr,
  pricing: PricingSchema,
  is_ready: z.union([z.boolean(), z.string(), z.number()]).optional().catch(undefined),
});
export type RawCatalogModel = z.infer<typeof RawCatalogModelSchema>;

/** Normalized, immutable model used across the app. */
export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputModalities: string[];
  readonly outputModalities: string[];
  /** context_length: the SHARED input+output window (max_tokens caps prompt+completion combined). */
  readonly contextLength?: number;
  /** max_output_length: a separate cap on OUTPUT tokens — NOT additive to the context window. */
  readonly maxOutputLength?: number;
  readonly supportedFeatures: string[];
  readonly supportedSamplingParameters: string[];
  readonly huggingFaceId?: string;
  readonly pricing?: Pricing;
  /** true = ready, false = cold (429 no-workers), undefined = unknown readiness. */
  readonly isReady?: boolean;
}

export function normalizeCatalogModel(raw: RawCatalogModel): CatalogModel {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description,
    inputModalities: raw.input_modalities ?? [],
    outputModalities: raw.output_modalities ?? [],
    contextLength: raw.context_length,
    maxOutputLength: raw.max_output_length,
    supportedFeatures: raw.supported_features ?? [],
    supportedSamplingParameters: raw.supported_sampling_parameters ?? [],
    huggingFaceId: raw.hugging_face_id,
    pricing: raw.pricing,
    isReady: decodeReadiness(raw.is_ready),
  };
}

export type Availability = "ready" | "cold" | "unknown";
export function availability(m: Pick<CatalogModel, "isReady">): Availability {
  if (m.isReady === true) return "ready";
  if (m.isReady === false) return "cold";
  return "unknown";
}

/** The ONE vision predicate: a model can see images iff its live catalog `inputModalities` includes "image".
 *  Catalog-driven — never a hardcoded model list — so it self-adjusts as the fleet changes. */
export function supportsVision(m: Pick<CatalogModel, "inputModalities">): boolean {
  return m.inputModalities.some((x) => x.toLowerCase() === "image");
}

/**
 * Wire envelope. The real shape is `{ object: "list", data: [...] }`; `models` is kept as a tolerant
 * fallback. A response with neither key is rejected (so we keep last-known-good rather than silently
 * normalizing junk to an empty catalog).
 */
export const CatalogResponseSchema = z
  .object({
    object: z.string().optional(),
    // Rows are validated ONE BY ONE in normalizeCatalog: a single malformed (or newer-shaped) model entry is
    // skipped instead of failing the whole catalog.
    data: z.array(z.unknown()).optional(),
    models: z.array(z.unknown()).optional(),
  })
  .refine((r) => r.data !== undefined || r.models !== undefined, {
    message: "catalog response missing a data/models envelope",
  });
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

/** Normalize + reconcile duplicate ids (first occurrence wins). */
export function normalizeCatalog(res: CatalogResponse): CatalogModel[] {
  const rows = res.data ?? res.models ?? [];
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const row of rows) {
    const parsed = RawCatalogModelSchema.safeParse(row);
    if (!parsed.success) continue; // a malformed row never takes the rest of the fleet down with it
    const m = normalizeCatalogModel(parsed.data);
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}
