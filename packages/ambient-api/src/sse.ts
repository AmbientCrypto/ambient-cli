import { AmbError, type ChatChunk, ChatChunkSchema } from "@amb/protocol";

/**
 * SSE parsing + OpenAI chat-completion accumulation.
 * Clean-room from ambient-code-bridge/ambient_code/upstream.py (MIT).
 *
 * The tricky part is reassembling a tool call whose `arguments` JSON is fragmented across many deltas
 * (and possibly across network chunk boundaries) — getting this wrong silently corrupts tool inputs.
 * The chunk wire-shape is validated by @amb/protocol's ChatChunkSchema (single source of truth).
 */

export interface SSEEvent {
  data: string;
}

/** Parse a complete SSE text payload into events. Ignores comment lines and non-data fields. */
export function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length > 0) events.push({ data: dataLines.join("\n") });
  }
  return events;
}

/** The `[DONE]` sentinel returned by parseChatChunk when the stream is complete. */
export const CHUNK_DONE = Symbol("chunk-done");

/**
 * Parse one SSE `data:` payload into a validated chat chunk. Returns CHUNK_DONE at `[DONE]`. Unlike a silent
 * skip, this THROWS a classified transport error on malformed JSON, a provider error object embedded in the
 * stream, or a chunk that fails the wire schema — so provider drift surfaces as a clear, retryable failure
 * instead of an unexplained empty answer (fail-fast).
 */
export function parseChatChunk(data: string): ChatChunk | typeof CHUNK_DONE {
  if (data === "[DONE]") return CHUNK_DONE;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new AmbError({
      kind: "transport",
      message: `malformed SSE chunk (not JSON): ${data.slice(0, 200)}`,
      retryable: true,
    });
  }
  // A provider error delivered mid-stream ({"error": {...}}) must not masquerade as an empty chunk.
  if (json && typeof json === "object" && "error" in json) {
    const e = (json as { error: unknown }).error;
    const msg =
      e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : JSON.stringify(e);
    throw new AmbError({
      kind: "transport",
      message: `provider error in stream: ${msg.slice(0, 200)}`,
      retryable: true,
    });
  }
  const parsed = ChatChunkSchema.safeParse(json);
  if (!parsed.success) {
    throw new AmbError({
      kind: "transport",
      message: `SSE chunk failed the wire schema: ${parsed.error.issues[0]?.message ?? "invalid shape"}`,
      retryable: true,
    });
  }
  return parsed.data;
}

export interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AccumulatedCompletion {
  content: string;
  reasoning: string;
  toolCalls: AccumulatedToolCall[];
  finishReason?: string;
  /** The model the provider actually served (from the response `model`), observed during the stream. */
  reportedModel?: string;
  usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number };
}

export interface AccumulatorCallbacks {
  onContent?: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** A tool call taking shape mid-stream: its name once known, then the file it targets once readable. */
  onToolDraft?: (draft: { name: string; path?: string }) => void;
  /** A chunk that carries no visible text: the model is producing output the server holds back until it's
   *  complete (a tool call's arguments arrive in one piece at the end). Called once per such chunk. */
  onHiddenOutput?: () => void;
}

/** How much already-searched argument text is searched again (a `"path": "…"` split across chunks). */
const DRAFT_SCAN_CHARS = 1_024;

/** The file a partly-streamed tool call's arguments name, once the whole value has arrived. */
function draftPath(args: string): string | undefined {
  const m = /"(?:path|file_path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args);
  if (!m?.[1]) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}

/** Incrementally folds SSE chunks into a settled completion, invoking callbacks as text streams in. */
export class ChatAccumulator {
  private content = "";
  private reasoning = "";
  private finishReason: string | undefined;
  private reportedModel: string | undefined;
  private usage: AccumulatedCompletion["usage"];
  /** Tool calls in first-seen order. Keyed by stream index when the provider sends one, else by call id —
   *  a provider that omits `index` must not have its parallel calls merged into one broken call. */
  private readonly toolMap = new Map<string, AccumulatedToolCall>();
  private readonly idToKey = new Map<string, string>();
  private lastToolKey: string | undefined;
  /** What's been reported for each call so far (name, then path), so each is reported once. */
  private readonly drafted = new Map<string, { name: boolean; path: boolean }>();
  /** Where the next search for a call's file may start. */
  private readonly draftScanned = new Map<string, number>();

  constructor(private readonly cb: AccumulatorCallbacks = {}) {}

  /**
   * Push one SSE event. Returns false when the `[DONE]` sentinel is seen (stop iterating). THROWS a classified
   * transport error on a malformed / error / off-schema chunk (parseChatChunk) rather than silently dropping it.
   */
  push(e: SSEEvent): boolean {
    const chunk = parseChatChunk(e.data);
    if (chunk === CHUNK_DONE) return false;
    if (this.reportedModel === undefined && typeof chunk.model === "string") {
      this.reportedModel = chunk.model;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      const r0 = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
      const empty =
        !delta.content && !r0 && !delta.tool_calls && !(delta as { role?: unknown }).role;
      if (empty && choice?.finish_reason == null) this.cb.onHiddenOutput?.();
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.content += delta.content;
        this.cb.onContent?.(delta.content);
      }
      const r = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
      if (typeof r === "string" && r.length > 0) {
        this.reasoning += r;
        this.cb.onReasoning?.(r);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const key = this.toolKey(tc);
          const cur = this.toolMap.get(key) ?? { id: "", name: "", arguments: "" };
          if (tc.id) {
            cur.id = tc.id;
            this.idToKey.set(tc.id, key);
          }
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          this.toolMap.set(key, cur);
          this.lastToolKey = key;
          this.reportDraft(key, cur);
        }
      }
    }
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      this.usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        ...(typeof cached === "number" ? { cachedTokens: cached } : {}),
      };
    }
    return true;
  }

  private reportDraft(key: string, cur: AccumulatedToolCall): void {
    if (!this.cb.onToolDraft || !cur.name) return;
    const seen = this.drafted.get(key) ?? { name: false, path: false };
    // Only the new text (plus a little overlap for a value split across chunks) is searched each time, so a
    // long argument isn't rescanned from the start on every chunk.
    const from = this.draftScanned.get(key) ?? 0;
    const path = seen.path ? undefined : draftPath(cur.arguments.slice(from));
    this.draftScanned.set(key, Math.max(0, cur.arguments.length - DRAFT_SCAN_CHARS));
    if (!seen.name || path) {
      this.cb.onToolDraft({ name: cur.name, ...(path ? { path } : {}) });
      this.drafted.set(key, { name: true, path: seen.path || path !== undefined });
    }
  }

  /** Stream index when present; else a previously-seen id; else a new id; else continue the latest call. */
  private toolKey(tc: { index?: number | null; id?: string | null }): string {
    if (typeof tc.index === "number") return `i${tc.index}`;
    if (tc.id) return this.idToKey.get(tc.id) ?? `id:${tc.id}`;
    return this.lastToolKey ?? "i0";
  }

  result(): AccumulatedCompletion {
    const toolCalls = [...this.toolMap.values()];
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls,
      finishReason: this.finishReason,
      reportedModel: this.reportedModel,
      usage: this.usage,
    };
  }
}

/** Fold a finished stream of SSE events into a settled completion. Stops at the `[DONE]` sentinel. */
export function accumulateChatStream(events: Iterable<SSEEvent>): AccumulatedCompletion {
  const acc = new ChatAccumulator();
  for (const e of events) {
    if (!acc.push(e)) break;
  }
  return acc.result();
}

/** The most text one SSE event may run to before the stream is treated as broken. */
const MAX_PENDING_EVENT_CHARS = 4 * 1024 * 1024;

/**
 * Incrementally parse SSE events from a byte stream, respecting arbitrary chunk boundaries. `onBytes` fires for
 * every body chunk (including keep-alive comments) so a watchdog can treat any traffic as liveness.
 */
export async function* readSSEStream(
  body: ReadableStream<Uint8Array>,
  onBytes?: () => void,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const sep = /\r?\n\r?\n/;
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onBytes?.();
    buf += decoder.decode(value, { stream: true });
    let m = sep.exec(buf);
    while (m) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      for (const ev of parseSSE(block)) yield ev;
      m = sep.exec(buf);
    }
    // A real event is a few KB; megabytes with no event boundary is a broken stream, not a slow one.
    if (buf.length > MAX_PENDING_EVENT_CHARS) {
      await reader.cancel().catch(() => {});
      throw new AmbError({
        kind: "transport",
        message: `the stream sent ${buf.length} characters without an event boundary`,
        retryable: true,
      });
    }
  }
  buf += decoder.decode();
  if (buf.trim().length > 0) {
    for (const ev of parseSSE(buf)) yield ev;
  }
}
