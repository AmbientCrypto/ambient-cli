import { type AmbientConfig, type FetchLike, authHeaders, chatUrl } from "./config.js";

export type KeyCheck = "valid" | "invalid" | "unknown";

/**
 * Check an API key WITHOUT running a model: a GET on the chat endpoint is authenticated first (401 for a bad
 * or missing key) and then rejected as the wrong method (405) for a good one — so nothing is inferred or
 * billed. A 5xx or network failure is `unknown`: sign-in proceeds rather than blocking on a flaky network.
 */
export async function verifyApiKey(
  config: AmbientConfig,
  opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<KeyCheck> {
  const doFetch = opts.fetch ?? (fetch as unknown as FetchLike);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(chatUrl(config), {
      method: "GET",
      headers: authHeaders(config),
      signal: ac.signal,
    });
    void res.body?.cancel().catch(() => {}); // only the status matters — release the connection
    if (res.status === 401 || res.status === 403) return "invalid";
    // Only a clear "authenticated" answer counts: 405 (right key, wrong method) or a 2xx. Anything else —
    // a 404 from a mistyped endpoint, a 429, a 5xx — means we couldn't tell.
    if (res.status === 405 || (res.status >= 200 && res.status < 300)) return "valid";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
