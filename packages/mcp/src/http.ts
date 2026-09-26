import type { Transport } from "./jsonrpc.js";

/** Config for a remote (Streamable HTTP) MCP server. */
export interface HttpServerConfig {
  url: string;
  headers?: Record<string, string>;
  /** The server speaks MCP's original HTTP+SSE binding (`"type": "sse"`), not Streamable HTTP. */
  legacySse?: boolean;
  /** Called when the server answers 401: a fresh access token to retry with once, or undefined. */
  reauthorize?: () => Promise<string | undefined>;
}

/** An HTTP failure from an MCP server — a 401 carries the header that says where to sign in. */
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly wwwAuthenticate?: string,
  ) {
    super(
      status === 401 ? "the server needs you to sign in" : `MCP server returned HTTP ${status}`,
    );
    this.name = "McpHttpError";
  }
}

/** The subset of fetch we use — injectable so tests never touch the network. */
interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** The real fetch Response exposes this; we stream it with a hard cap so an untrusted server can't OOM us
   *  by returning a multi-GB body. Test fakes omit it and fall back to `text()`. */
  body?: ReadableStream<Uint8Array> | null;
}
export type HttpFetch = (url: string, init: Record<string, unknown>) => Promise<HttpResponse>;

const REQUEST_TIMEOUT_MS = 120_000; // bound a hanging response (the JsonRpcClient also times out per request)
const MAX_BODY_CHARS = 8_000_000; // never buffer an unbounded response body

/** Read a response body with a HARD char cap, streaming from res.body so a huge/hostile body is never fully
 *  materialized (the OOM the plain `(await res.text()).slice()` allowed). Falls back to text() for test fakes. */
async function readBodyCapped(res: HttpResponse, maxChars: number): Promise<string> {
  if (!res.body || typeof res.body.getReader !== "function") {
    return (await res.text()).slice(0, maxChars);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= maxChars) {
        out = out.slice(0, maxChars);
        break; // stop pulling — we have enough (finally cancels the rest)
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already done */
    }
  }
  return out;
}

/** The configured headers, with a refreshed token replacing any Authorization header (in any casing). */
function withBearer(
  headers: Record<string, string> | undefined,
  bearer: string | undefined,
): Record<string, string> {
  if (!bearer) return { ...headers };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {}))
    if (k.toLowerCase() !== "authorization") out[k] = v;
  out.Authorization = `Bearer ${bearer}`;
  return out;
}

/**
 * A `Transport` over the MCP **Streamable HTTP** binding: each JSON-RPC message is POSTed to the endpoint and
 * the response (a single JSON object OR an `text/event-stream` of `data:` events) is parsed back onto
 * `onMessage`. Maintains the `Mcp-Session-Id` the server assigns on initialize. v1: one POST per outbound
 * message (no long-lived GET stream) — enough for request/response tools, which is all we call.
 */
export function spawnHttpTransport(
  cfg: HttpServerConfig,
  fetchImpl?: HttpFetch,
): { transport: Transport } {
  const doFetch: HttpFetch =
    fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<HttpResponse>);
  let onMsg: (m: unknown) => void = () => {};
  let onClose: (err?: Error) => void = () => {};
  let closed = false;
  let sessionId: string | undefined;
  let bearer: string | undefined;

  const deliver = (raw: string): void => {
    const text = raw.trim();
    if (text.length === 0) return;
    try {
      onMsg(JSON.parse(text));
    } catch {
      /* a malformed line is dropped — a peer can't crash us with junk */
    }
  };

  const transport: Transport = {
    send: (line) => {
      if (closed) return;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
      const post = () =>
        doFetch(cfg.url, {
          method: "POST",
          signal: ac.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            ...withBearer(cfg.headers, bearer),
          },
          body: line.trim(),
        });
      post()
        .then(async (first) => {
          let res = first;
          // An expired sign-in: get a fresh token once and retry the same message.
          if (res.status === 401 && cfg.reauthorize) {
            const token = await cfg.reauthorize();
            if (token) {
              bearer = token;
              res = await post();
            }
          }
          if (res.status >= 400) {
            throw new McpHttpError(res.status, res.headers.get("www-authenticate") ?? undefined);
          }
          const sid = res.headers.get("mcp-session-id");
          if (sid) sessionId = sid;
          const body = await readBodyCapped(res, MAX_BODY_CHARS);
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("text/event-stream")) {
            // Parse SSE frames: each `\n\n`-separated block may carry one or more `data:` lines.
            for (const block of body.split(/\r?\n\r?\n/)) {
              const data = block
                .split(/\r?\n/)
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("");
              if (data) deliver(data);
            }
          } else {
            deliver(body); // a single JSON response (a notification 202s with an empty body → ignored)
          }
        })
        .catch((e) => {
          if (!closed) onClose(e as Error);
        })
        .finally(() => clearTimeout(timer));
    },
    onMessage: (cb) => {
      onMsg = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    close: () => {
      closed = true; // HTTP is per-request; nothing persistent to tear down (session expires server-side)
    },
  };
  return { transport };
}
