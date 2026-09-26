/**
 * A minimal JSON-RPC 2.0 client over a newline-delimited-JSON transport (the MCP stdio framing). Kept
 * transport-agnostic — `Transport` is just "send a framed string + receive parsed messages + close" — so the
 * whole client is testable over an in-memory pipe with no child process. Bounded: each request has a timeout,
 * and a closed endpoint rejects every in-flight request (never hangs the agent).
 */

export interface Transport {
  /** Send one already-framed message string (framing = the JSON + a trailing newline). */
  send(line: string): void;
  /** Register the sink for INBOUND parsed JSON messages. */
  onMessage(cb: (msg: unknown) => void): void;
  /** Register a handler for transport death (process exit / pipe error). */
  onClose(cb: (err?: Error) => void): void;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

/** A single MCP frame (one newline-delimited JSON message) may not exceed this many characters. A server
 *  that streams without ever emitting a newline would otherwise grow the buffer without bound (memory DoS).
 *  When the pending line exceeds it we drop the buffer and resync at the next newline. */
const MAX_FRAME_CHARS = 8_000_000;

/** Split a byte/char stream into complete newline-delimited JSON messages (handles chunk boundaries). */
export class LineFramer {
  private buf = "";
  /** True while we are discarding an over-long line until the next newline resynchronizes framing. */
  private overflowing = false;
  constructor(
    private readonly onMessage: (msg: unknown) => void,
    private readonly maxFrameChars: number = MAX_FRAME_CHARS,
  ) {}
  push(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl !== -1) {
      const rawLen = nl; // length of the completed line BEFORE trim (what we cap on)
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      // A newline ends any overflow run: the oversized (dropped) line is gone; resume normal framing.
      // Also drop a completed-but-over-cap line HERE (not just the pending tail) so an oversized message
      // whose newline lands in the same chunk is never handed to JSON.parse (memory-DoS bound).
      if (this.overflowing) this.overflowing = false;
      else if (rawLen > this.maxFrameChars) {
        // dropped — too large to parse
      } else if (line.length > 0) {
        try {
          this.onMessage(JSON.parse(line));
        } catch {
          // A malformed line is dropped — a peer must not be able to crash us with junk.
        }
      }
      nl = this.buf.indexOf("\n");
    }
    // No newline yet and the pending line is over the cap ⇒ drop it and discard until the next newline, so a
    // hostile/broken server can never make us buffer unbounded bytes.
    if (this.buf.length > this.maxFrameChars) {
      this.buf = "";
      this.overflowing = true;
    }
  }
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly timeoutMs: number;
  private notificationHandler: (method: string, params: unknown) => void = () => {};

  constructor(
    private readonly transport: Transport,
    opts: { requestTimeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    transport.onMessage((msg) => this.handle(msg));
    transport.onClose((err) => this.fail(err ?? new Error("transport closed")));
  }

  /** Issue a request and await its result (or reject on error/timeout/close). `timeoutMs` overrides the
   *  client default for THIS call — the handshake/list use the short default, a tool call a longer one. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new JsonRpcError("client is closed"));
    const id = this.nextId++;
    const ms = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcError(`request '${method}' timed out after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Receive the server's notifications (e.g. `notifications/tools/list_changed`). */
  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationHandler = cb;
  }

  /** Fire-and-forget notification (no id, no response). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.transport.send(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    this.fail(new JsonRpcError("client closed"));
    this.transport.close();
  }

  private handle(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { message?: string; code?: number; data?: unknown };
    };
    if (typeof m.method === "string") {
      if (m.id === undefined) {
        try {
          this.notificationHandler(m.method, m.params);
        } catch {
          // a handler failure never breaks the connection
        }
        return;
      }
      // A request FROM the server: answer ping; decline everything else (no sampling/roots from us), so the
      // server isn't left waiting.
      if (typeof m.id === "number" || typeof m.id === "string") {
        const reply =
          m.method === "ping"
            ? { jsonrpc: "2.0", id: m.id, result: {} }
            : {
                jsonrpc: "2.0",
                id: m.id,
                error: { code: -32601, message: "method not supported" },
              };
        if (!this.closed) this.transport.send(`${JSON.stringify(reply)}\n`);
      }
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error)
      p.reject(new JsonRpcError(m.error.message ?? "server error", m.error.code, m.error.data));
    else p.resolve(m.result);
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
