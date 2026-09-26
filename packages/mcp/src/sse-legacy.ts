import { type HttpServerConfig, McpHttpError } from "./http.js";
import type { Transport } from "./jsonrpc.js";

/**
 * A `Transport` over MCP's original HTTP+SSE binding (`"type": "sse"` servers): a long-lived GET event
 * stream, whose first `endpoint` event names where to POST messages; replies arrive back on the stream as
 * `message` events. Messages sent before the endpoint is known wait for it. The endpoint must be on the
 * same origin as the stream, so auth headers are never posted anywhere else.
 */

interface StreamResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}
export type SseFetch = (url: string, init: Record<string, unknown>) => Promise<StreamResponse>;

/** An event larger than this is dropped (a server can't make us buffer without bound). */
const MAX_EVENT_CHARS = 8_000_000;
const POST_TIMEOUT_MS = 120_000;

/** Split an SSE byte stream into events: `event:` names it, `data:` lines (joined by \n) carry it. */
export class SseParser {
  private buf = "";
  constructor(private readonly onEvent: (event: string, data: string) => void) {}
  push(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(":")) continue; // a comment / keep-alive
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) this.onEvent(event, data.join("\n"));
    }
    if (this.buf.length > MAX_EVENT_CHARS) this.buf = "";
  }
}

export function spawnSseTransport(
  cfg: HttpServerConfig,
  fetchImpl?: SseFetch,
): { transport: Transport } {
  const doFetch: SseFetch =
    fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<StreamResponse>);
  let onMsg: (m: unknown) => void = () => {};
  let onClose: (err?: Error) => void = () => {};
  let closed = false;
  let endpoint: string | undefined;
  const queued: string[] = [];
  const stream = new AbortController();
  const origin = new URL(cfg.url).origin;

  const fail = (err: Error) => {
    if (closed) return;
    closed = true;
    stream.abort();
    onClose(err);
  };

  const post = (line: string) => {
    if (!endpoint || closed) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), POST_TIMEOUT_MS);
    doFetch(endpoint, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", ...cfg.headers },
      body: line.trim(),
    })
      .then((res) => {
        if (!res.ok && res.status !== 202)
          fail(new Error(`MCP server returned HTTP ${res.status}`));
      })
      .catch((e: unknown) => fail(e as Error))
      .finally(() => clearTimeout(timer));
  };

  const parser = new SseParser((event, data) => {
    if (event === "endpoint") {
      let next: URL;
      try {
        next = new URL(data.trim(), cfg.url);
      } catch {
        fail(new Error("MCP server sent an invalid message endpoint"));
        return;
      }
      if (next.origin !== origin) {
        fail(new Error("MCP server's message endpoint is on another origin (refused)"));
        return;
      }
      endpoint = next.toString();
      for (const line of queued.splice(0)) post(line);
      return;
    }
    if (event !== "message") return;
    try {
      onMsg(JSON.parse(data));
    } catch {
      // a malformed event is dropped — a peer can't crash us with junk
    }
  });

  void doFetch(cfg.url, {
    method: "GET",
    signal: stream.signal,
    headers: { accept: "text/event-stream", ...cfg.headers },
  })
    .then(async (res) => {
      if (!res.ok || !res.body)
        throw new McpHttpError(res.status, res.headers?.get("www-authenticate") ?? undefined);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      fail(new Error("MCP server closed the event stream"));
    })
    .catch((e: unknown) => fail(e as Error));

  const transport: Transport = {
    send: (line) => {
      if (closed) return;
      if (endpoint) post(line);
      else queued.push(line);
    },
    onMessage: (cb) => {
      onMsg = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    close: () => {
      closed = true;
      stream.abort();
    },
  };
  return { transport };
}
