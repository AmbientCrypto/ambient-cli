import { type CatalogModel, CatalogResponseSchema, normalizeCatalog } from "@amb/protocol";
import { type AmbientConfig, type FetchLike, authHeaders, catalogUrl } from "./config.js";

/**
 * Fetch + normalize the live model catalog (GET /v1/models). Readable WITHOUT an API key.
 * Never hardcode the model list — this is the single source of truth for what can serve.
 */
export async function fetchCatalog(
  config: AmbientConfig,
  opts: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<CatalogModel[]> {
  const doFetch = opts.fetch ?? (fetch as unknown as FetchLike);
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders(config) };
  const res = await doFetch(catalogUrl(config), { headers, signal: opts.signal });
  if (!res.ok) {
    throw new Error(`Ambient catalog fetch failed: ${res.status} ${res.statusText}`);
  }
  const json: unknown = await res.json();
  return normalizeCatalog(CatalogResponseSchema.parse(json));
}
