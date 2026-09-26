import type { McpAuthPort } from "../agent/mcp-connect.js";
import { type OAuthFetch, accessToken } from "./oauth.js";
import { type TokenStore, makeTokenStore } from "./token-store.js";

/** A sign-in server that stops answering, or answers without end, must not hold up ambient. */
const OAUTH_TIMEOUT_MS = 30_000;
const MAX_OAUTH_BODY_BYTES = 1_000_000;

async function textCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("the sign-in server's answer was too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const realFetch: OAuthFetch = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) });
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: () => textCapped(res, MAX_OAUTH_BODY_BYTES),
  };
};

/** Stored MCP sign-ins as the connect step uses them: the current token, and a refreshed one on a 401. */
export function makeMcpAuth(
  store: TokenStore = makeTokenStore(),
  fetchImpl: OAuthFetch = realFetch,
): McpAuthPort {
  // One refresh per server at a time: parallel calls that all hit a 401 share it, instead of each spending
  // the refresh token (a server that rotates refresh tokens would reject the second and sign you out).
  const inFlight = new Map<string, Promise<string | undefined>>();
  return {
    token: (url) => accessToken(url, { fetch: fetchImpl, store }),
    refresh(url) {
      const pending = inFlight.get(url);
      if (pending) return pending;
      const p = accessToken(url, { fetch: fetchImpl, store, forceRefresh: true }).finally(() =>
        inFlight.delete(url),
      );
      inFlight.set(url, p);
      return p;
    },
  };
}
