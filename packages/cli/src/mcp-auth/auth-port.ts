import type { McpAuthPort } from "../agent/mcp-connect.js";
import { type OAuthFetch, accessToken } from "./oauth.js";
import { type TokenStore, makeTokenStore } from "./token-store.js";

export const realFetch: OAuthFetch = (url, init) => fetch(url, init);

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
