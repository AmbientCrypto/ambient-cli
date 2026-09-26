import { type CatalogModel, CatalogResponseSchema, normalizeCatalog } from "@amb/protocol";
import { type AmbientConfig, type FetchLike, authHeaders, catalogUrl } from "./config.js";

/** How long fetching and reading the model list may take. */
const CATALOG_TIMEOUT_MS = 30_000;

/**
 * Fetch + normalize the live model catalog (GET /v1/models). Readable WITHOUT an API key.
 * Never hardcode the model list — this is the single source of truth for what can serve.
 */
export async function fetchCatalog(
  config: AmbientConfig,
  opts: { fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CatalogModel[]> {
  const doFetch = opts.fetch ?? (fetch as unknown as FetchLike);
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders(config) };
  // A catalog that never finishes arriving must not hold a run: it gets a deadline, as well as the caller's
  // own stop signal.
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? CATALOG_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const res = await doFetch(catalogUrl(config), { headers, signal });
  if (!res.ok) {
    throw new Error(`Ambient catalog fetch failed: ${res.status} ${res.statusText}`);
  }
  const json: unknown = await res.json();
  return normalizeCatalog(CatalogResponseSchema.parse(json));
}
