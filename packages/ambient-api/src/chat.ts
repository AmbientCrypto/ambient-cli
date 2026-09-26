import { AmbError, ChatRequestSchema } from "@amb/protocol";
import { type StreamTimeouts, parseRetryAfter } from "@amb/reliability";
import { type AmbientConfig, type FetchLike, authHeaders, chatUrl } from "./config.js";
import { classifyHttpError } from "./errors.js";
import {
  type AccumulatedCompletion,
  type AccumulatorCallbacks,
  ChatAccumulator,
  type SSEEvent,
  readSSEStream,
} from "./sse.js";
import { StallWatchdog } from "./watchdog.js";

export interface StreamOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  hasImage?: boolean;
  /** Bound the request with first-byte + idle clocks. Omitted ⇒ unbounded (legacy callers/tests). */
  timeouts?: StreamTimeouts;
}

export interface ChatRequest {
  model: string;
  messages: unknown[];
  maxTokens?: number;
  tools?: unknown[];
  temperature?: number;
  /** Reasoning effort — the caller sends it only for reasoning-capable models. */
  reasoningEffort?: "none" | "high" | "max";
}

/** Build the OpenAI-compatible body Ambient expects. Always streamed with usage included. */
export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  // Only send `tools` when there is at least one — an empty array is rejected by some models (and the
  // assisted lane deliberately sends no tools, describing them as text instead).
  if (Array.isArray(req.tools) && req.tools.length > 0) body.tools = req.tools;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.reasoningEffort !== undefined) body.reasoning_effort = req.reasoningEffort;
  return body;
}

/**
 * POST /v1/chat/completions and stream SSE events. Throws a classified AmbError on a non-OK response, and a
 * RETRYABLE transport error when the watchdog sees the worker stall (so failover can take over).
 */
export async function* streamChat(
  config: AmbientConfig,
  req: ChatRequest,
  opts: StreamOptions = {},
): AsyncGenerator<SSEEvent> {
  const doFetch = opts.fetch ?? (fetch as unknown as FetchLike);
  // Validate the OUTBOUND body against the wire schema before sending — a malformed request is our bug, not a
  // transient, so fail fast (non-retryable) with a clear message instead of letting the provider 400 opaquely.
  const body = buildChatBody(req);
  const validated = ChatRequestSchema.safeParse(body);
  if (!validated.success) {
    throw new AmbError({
      kind: "bad_request",
      message: `outbound chat body failed validation: ${validated.error.issues[0]?.message ?? "invalid"}`,
      retryable: false,
      model: req.model,
    });
  }
  const wd = opts.timeouts ? new StallWatchdog(opts.timeouts, opts.signal) : undefined;
  try {
    const res = await doFetch(chatUrl(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...authHeaders(config),
      },
      body: JSON.stringify(body),
      signal: wd?.signal ?? opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryAfterMs = parseRetryAfter(res.headers?.get?.("retry-after"));
      throw classifyHttpError(res.status, text, {
        model: req.model,
        hasImage: opts.hasImage,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    if (!res.body) throw new Error("Ambient chat response has no body");
    yield* readSSEStream(res.body as ReadableStream<Uint8Array>, wd ? () => wd.alive() : undefined);
  } catch (e) {
    // A classified error (HTTP status, provider error in the stream) is the truth even if a clock fired while
    // its body was being read — keep its kind and Retry-After instead of rewriting it as a stall.
    if (e instanceof AmbError) throw e;
    if (wd?.stalled) throw wd.error(req.model);
    const network = describeNetworkFailure(e);
    if (network) {
      throw new AmbError({
        kind: "transport",
        message: network,
        retryable: true,
        model: req.model,
      });
    }
    throw e;
  } finally {
    wd?.dispose();
  }
}

/** Human wording for common socket-level causes behind Node's bare "fetch failed". */
const NETWORK_CAUSES: Record<string, string> = {
  ECONNRESET: "the connection was reset",
  ECONNREFUSED: "the connection was refused",
  ETIMEDOUT: "the connection timed out",
  ENOTFOUND: "the address couldn't be resolved (DNS)",
  EAI_AGAIN: "DNS lookup failed temporarily",
  ENETUNREACH: "the network is unreachable",
  EHOSTUNREACH: "the host is unreachable",
  UND_ERR_SOCKET: "the connection closed unexpectedly",
  UND_ERR_CONNECT_TIMEOUT: "connecting timed out",
};

/**
 * Node reports every socket problem as `TypeError: fetch failed` with the real reason in `cause`. Say what
 * actually happened ("network error reaching Ambient — the connection was reset"); undefined when `e` isn't a
 * network failure (an abort, or any other error, is left alone).
 */
export function describeNetworkFailure(e: unknown): string | undefined {
  if (!(e instanceof TypeError) || e.message !== "fetch failed") return undefined;
  const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  const why =
    (code && NETWORK_CAUSES[code]) ??
    (typeof cause?.message === "string" && cause.message ? cause.message : code);
  return `network error reaching Ambient${why ? ` — ${why}` : ""}`;
}

/** Convenience: stream a chat completion to completion, invoking callbacks as text arrives. */
export async function streamChatCompletion(
  config: AmbientConfig,
  req: ChatRequest,
  opts: StreamOptions & AccumulatorCallbacks = {},
): Promise<AccumulatedCompletion> {
  const acc = new ChatAccumulator({
    onContent: opts.onContent,
    onReasoning: opts.onReasoning,
    ...(opts.onToolDraft ? { onToolDraft: opts.onToolDraft } : {}),
    ...(opts.onHiddenOutput ? { onHiddenOutput: opts.onHiddenOutput } : {}),
  });
  for await (const e of streamChat(config, req, opts)) {
    if (!acc.push(e)) break;
  }
  return acc.result();
}
