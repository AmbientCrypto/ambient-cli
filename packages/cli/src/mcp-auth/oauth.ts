import { createHash, randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { ServerAuthRecord, StoredClient, StoredTokens, TokenStore } from "./token-store.js";

/**
 * Signing in to a remote MCP server, per the MCP authorization spec: the server's 401 names its protected-
 * resource metadata, which names the authorization server; ambient registers itself there (dynamic client
 * registration), opens the browser with a PKCE-protected authorization request, receives the code on a
 * loopback address, and trades it for tokens it keeps in the encrypted token store. Tokens are refreshed
 * when they expire. Every endpoint must be https (or loopback), and PKCE S256 is required.
 */

export type OAuthFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface AuthServerInfo {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
}

const CALLBACK_TIMEOUT_MS = 5 * 60_000;
/** Refresh a token this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** An endpoint tokens or codes travel to must be https, or on this machine. */
function secureUrl(raw: unknown, what: string): string {
  if (typeof raw !== "string") throw new McpAuthError(`the server's sign-in setup has no ${what}`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new McpAuthError(`the server's ${what} isn't a valid URL`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) {
    throw new McpAuthError(`the server's ${what} isn't https (refused)`);
  }
  return u.toString();
}

async function getJson(
  fetchImpl: OAuthFetch,
  url: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    const parsed = JSON.parse(await res.text()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `resource_metadata="…"` from a `WWW-Authenticate: Bearer …` header. */
export function resourceMetadataUrl(
  wwwAuthenticate: string | null | undefined,
): string | undefined {
  const m = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate ?? "");
  return m?.[1];
}

/** Well-known locations for a URL: path-inserted first (RFC 8414 §3), then at the origin root. */
function wellKnown(base: string, suffix: string): string[] {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, "");
  const out = path ? [`${u.origin}/.well-known/${suffix}${path}`] : [];
  out.push(`${u.origin}/.well-known/${suffix}`);
  return out;
}

/** Find where to sign in for an MCP server. */
export async function discoverAuthServer(
  serverUrl: string,
  wwwAuthenticate: string | null | undefined,
  fetchImpl: OAuthFetch,
): Promise<AuthServerInfo> {
  const named = resourceMetadataUrl(wwwAuthenticate);
  const candidates = [
    ...(named && tokenSafeUrl(named) ? [named] : []),
    ...wellKnown(serverUrl, "oauth-protected-resource"),
  ];
  let issuer: string | undefined;
  let scopes: string[] | undefined;
  for (const url of candidates) {
    const prm = await getJson(fetchImpl, url);
    const servers = prm?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      issuer = servers[0];
      if (Array.isArray(prm?.scopes_supported)) {
        scopes = prm.scopes_supported.filter((s): s is string => typeof s === "string");
      }
      break;
    }
  }
  // Servers from before protected-resource metadata are their own authorization server.
  const base = issuer ?? new URL(serverUrl).origin;
  let meta: Record<string, unknown> | undefined;
  for (const url of [
    ...wellKnown(base, "oauth-authorization-server"),
    ...wellKnown(base, "openid-configuration"),
  ]) {
    meta = await getJson(fetchImpl, url);
    if (meta?.authorization_endpoint && meta.token_endpoint) break;
    meta = undefined;
  }
  const origin = new URL(base).origin;
  const methods = meta?.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new McpAuthError("the server's sign-in doesn't support PKCE (S256) — refused");
  }
  return {
    authorizationEndpoint: secureUrl(
      meta?.authorization_endpoint ?? `${origin}/authorize`,
      "authorization endpoint",
    ),
    tokenEndpoint: secureUrl(meta?.token_endpoint ?? `${origin}/token`, "token endpoint"),
    ...(meta
      ? meta.registration_endpoint
        ? { registrationEndpoint: secureUrl(meta.registration_endpoint, "registration endpoint") }
        : {}
      : { registrationEndpoint: secureUrl(`${origin}/register`, "registration endpoint") }),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  };
}

const b64url = (b: Buffer) => b.toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

async function postForm(
  fetchImpl: OAuthFetch,
  url: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const why = typeof body.error_description === "string" ? body.error_description : body.error;
    throw new McpAuthError(
      `the server refused the sign-in (${String(why ?? `HTTP ${res.status}`)})`,
    );
  }
  return body;
}

function toTokens(body: Record<string, unknown>, now: number): StoredTokens {
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new McpAuthError("the server's token response had no access token");
  }
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === "number" ? { expiresAt: now + body.expires_in * 1000 } : {}),
    ...(typeof body.token_type === "string" ? { tokenType: body.token_type } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

async function register(
  fetchImpl: OAuthFetch,
  endpoint: string,
  redirectUri: string,
): Promise<StoredClient> {
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Ambient CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  if (!res.ok || typeof body.client_id !== "string") {
    throw new McpAuthError(
      `the server didn't let ambient register for sign-in (HTTP ${res.status})`,
    );
  }
  return {
    clientId: body.client_id,
    ...(typeof body.client_secret === "string" ? { clientSecret: body.client_secret } : {}),
    redirectUri,
  };
}

/** A one-shot loopback listener for the authorization redirect. */
async function listen(port: number): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? addr.port : port };
}

const DONE_PAGE = (ok: boolean, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Ambient</title><body style="font:16px system-ui;margin:3em">${ok ? "✓" : "✗"} ${text}</body>`;

function awaitCode(server: Server, state: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new McpAuthError("sign-in timed out")),
      CALLBACK_TIMEOUT_MS,
    );
    const onAbort = () => finish(new McpAuthError("sign-in cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (err?: Error, code?: string) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.close();
      if (err) reject(err);
      else resolve(code as string);
    };
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state) {
        res
          .writeHead(400, { "content-type": "text/html" })
          .end(DONE_PAGE(false, "That sign-in link doesn't match. Try again from ambient."));
        return; // a stray or forged request doesn't end the wait
      }
      if (error || !code) {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(DONE_PAGE(false, "Sign-in was not completed."));
        finish(new McpAuthError(`sign-in was declined (${error ?? "no code"})`));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(DONE_PAGE(true, "Signed in. You can close this tab and go back to ambient."));
      finish(undefined, code);
    });
  });
}

export interface SignInDeps {
  fetch: OAuthFetch;
  store: TokenStore;
  /** Open the authorization page; returns false when no browser could be opened. */
  openBrowser: (url: string) => boolean;
  /** Told the authorization URL, so it can be shown for copying when the browser didn't open. */
  onUrl?: (url: string) => void;
  now?: () => number;
  signal?: AbortSignal;
}

/** Ask the server for its 401 challenge (the header that says where to sign in). */
async function challenge(fetchImpl: OAuthFetch, serverUrl: string): Promise<string | null> {
  try {
    const res = await fetchImpl(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    });
    return res.headers.get("www-authenticate");
  } catch {
    return null;
  }
}

/** Whether sign-in tokens may be sent to this server: https, or a server on this machine. */
export function tokenSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname));
  } catch {
    return false;
  }
}

/** The full browser sign-in for one server; stores and returns the record. */
export async function signIn(serverUrl: string, deps: SignInDeps): Promise<ServerAuthRecord> {
  if (!tokenSafeUrl(serverUrl)) {
    throw new McpAuthError("the server isn't on https, so ambient won't sign in to it");
  }
  const now = deps.now ?? Date.now;
  const info = await discoverAuthServer(
    serverUrl,
    await challenge(deps.fetch, serverUrl),
    deps.fetch,
  );
  const previous = deps.store.get(serverUrl);
  // Reuse the registered client when its loopback port is free; otherwise register again on a new port.
  let client = previous?.client;
  let listener: { server: Server; port: number } | undefined;
  if (client) {
    try {
      listener = await listen(Number(new URL(client.redirectUri).port));
    } catch {
      client = undefined;
    }
  }
  if (!listener) listener = await listen(0);
  try {
    if (!client) {
      if (!info.registrationEndpoint) {
        throw new McpAuthError(
          "this server needs an app registered in advance, which ambient can't do yet",
        );
      }
      client = await register(
        deps.fetch,
        info.registrationEndpoint,
        `http://127.0.0.1:${listener.port}/callback`,
      );
    }
    const { verifier, challenge: codeChallenge } = pkcePair();
    const state = b64url(randomBytes(16));
    const auth = new URL(info.authorizationEndpoint);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("client_id", client.clientId);
    auth.searchParams.set("redirect_uri", client.redirectUri);
    auth.searchParams.set("code_challenge", codeChallenge);
    auth.searchParams.set("code_challenge_method", "S256");
    auth.searchParams.set("state", state);
    auth.searchParams.set("resource", serverUrl);
    if (info.scopes) auth.searchParams.set("scope", info.scopes.join(" "));
    const codePromise = awaitCode(listener.server, state, deps.signal);
    deps.onUrl?.(auth.toString());
    deps.openBrowser(auth.toString());
    const code = await codePromise;
    const body = await postForm(deps.fetch, info.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
      resource: serverUrl,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    });
    const record: ServerAuthRecord = {
      tokens: toTokens(body, now()),
      client,
      tokenEndpoint: info.tokenEndpoint,
      resource: serverUrl,
    };
    deps.store.set(serverUrl, record);
    return record;
  } finally {
    listener.server.close();
  }
}

/**
 * A usable access token for a server, refreshing an expired one when possible. Undefined when there's none
 * (never signed in, or the refresh was refused — the user needs to sign in again).
 */
export async function accessToken(
  serverUrl: string,
  deps: { fetch: OAuthFetch; store: TokenStore; now?: () => number; forceRefresh?: boolean },
): Promise<string | undefined> {
  const now = (deps.now ?? Date.now)();
  const record = deps.store.get(serverUrl);
  const tokens = record?.tokens;
  if (!record || !tokens) return undefined;
  const fresh = tokens.expiresAt === undefined || tokens.expiresAt - EXPIRY_MARGIN_MS > now;
  if (fresh && !deps.forceRefresh) return tokens.accessToken;
  if (!tokens.refreshToken || !record.tokenEndpoint || !record.client) return undefined;
  try {
    const body = await postForm(deps.fetch, record.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: record.client.clientId,
      resource: serverUrl,
      ...(record.client.clientSecret ? { client_secret: record.client.clientSecret } : {}),
    });
    const next = toTokens(body, now);
    // Some servers rotate refresh tokens, others keep the old one.
    const merged = { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
    deps.store.set(serverUrl, { ...record, tokens: merged });
    return merged.accessToken;
  } catch {
    return undefined;
  }
}
