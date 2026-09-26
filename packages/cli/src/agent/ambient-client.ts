import { randomUUID } from "node:crypto";
import {
  type AmbientConfig,
  type ChatRequest,
  type FetchLike,
  fetchCatalog,
  streamChatCompletion,
} from "@amb/ambient-api";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, Msg, ToolCall, TurnCompletion } from "@amb/runtime";

/** The real Ambient adapter: implements the runtime's ChatClient over @amb/ambient-api. Ambient-only. */
export class AmbientChatClient implements ChatClient {
  private cached: { at: number; models: CatalogModel[] } | undefined;
  private readonly ttlMs: number;
  private readonly doFetch: FetchLike | undefined;

  /**
   * The catalog is reused for a short while (default 30s) so every message doesn't re-download the fleet;
   * failover and model switches ask for a fresh copy. A failed refresh falls back to the last good catalog.
   */
  constructor(
    private config: AmbientConfig,
    opts: { fetch?: FetchLike; ttlMs?: number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.doFetch = opts.fetch;
  }

  /** Switch to a new API key for every later request (the in-app /login flow). */
  setApiKey(apiKey: string): void {
    this.config = { ...this.config, apiKey };
  }

  async fetchCatalog(
    signal?: AbortSignal,
    opts: { fresh?: boolean } = {},
  ): Promise<CatalogModel[]> {
    const c = this.cached;
    if (!opts.fresh && c && Date.now() - c.at < this.ttlMs) return c.models;
    try {
      const models = await fetchCatalog(this.config, {
        ...(signal ? { signal } : {}),
        ...(this.doFetch ? { fetch: this.doFetch } : {}),
      });
      this.cached = { at: Date.now(), models };
      return models;
    } catch (e) {
      // Keep working on the last good fleet through an outage: an old list beats a failed run, and a model
      // that has since gone away fails over like any unavailable one.
      if (c && !signal?.aborted) return c.models;
      throw e;
    }
  }

  async chat(params: ChatParams): Promise<TurnCompletion> {
    const req: ChatRequest = {
      model: params.model,
      messages: toWireMessages(params.messages),
      maxTokens: params.maxTokens,
      tools: params.tools,
      // Sent only when the agent resolved a concrete effort for a reasoning-capable served model.
      ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
    };
    const out = await streamChatCompletion(this.config, req, {
      signal: params.signal,
      ...(params.timeouts ? { timeouts: params.timeouts } : {}),
      onContent: params.onContent,
      onReasoning: params.onReasoning,
      ...(params.onToolDraft ? { onToolDraft: params.onToolDraft } : {}),
      ...(params.onHiddenOutput ? { onHiddenOutput: params.onHiddenOutput } : {}),
      // Tell the API layer the outbound body carries image parts, so an image-related 400 from a model that
      // can't actually see images is NOT misclassified as a context overflow (which would trigger compaction).
      hasImage: params.hasImage ?? messagesHaveImageParts(params.messages),
    });
    const toolCalls: ToolCall[] = out.toolCalls.map((tc) => ({
      // Synthesize a GLOBALLY-unique id when the provider omitted one, so ids never collide across
      // parallel calls OR across turns — a per-response index alone repeats as tc_read_0.
      id: tc.id || `tc_${tc.name}_${randomUUID().slice(0, 8)}`,
      name: tc.name,
      args: parseToolArgs(tc.arguments),
      rawArgs: tc.arguments,
    }));
    return {
      content: out.content,
      toolCalls,
      finishReason: out.finishReason,
      reportedModel: out.reportedModel,
      usage: out.usage,
    };
  }
}

/**
 * Parse streamed tool arguments. Empty/whitespace means a zero-argument call (`list()`), which is valid and
 * must not be mistaken for malformed JSON. Returns undefined only for genuinely unparseable input.
 */
export function parseToolArgs(json: string): unknown {
  if (json.trim().length === 0) return {};
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Translate the runtime's message shape into OpenAI wire messages (assistant tool_calls + tool results). */
export function toWireMessages(messages: Msg[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        // Bridge canonical shape: content is null (not "") when tool_calls are present.
        content: typeof m.content === "string" && m.content.length > 0 ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          // A zero-argument call streams "" — echo it back as a valid empty object for strict chat templates.
          function: { name: tc.name, arguments: tc.rawArgs.trim() === "" ? "{}" : tc.rawArgs },
        })),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: wireContent(m.content),
      };
    }
    return {
      role: m.role,
      content: wireContent(m.content),
    };
  });
}

/**
 * Shape a message's content for the wire. A content-parts ARRAY (text + image_url, the OpenAI vision format)
 * passes through VERBATIM so image parts survive (stringifying non-string content would collapse them into a
 * dead string). A string stays a string; anything else is stringified defensively.
 */
function wireContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content;
  return JSON.stringify(content ?? "");
}

/** True if any message carries an image content-part — drives the API layer's image-vs-overflow 400 classify. */
export function messagesHaveImageParts(messages: Msg[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (p) =>
          p !== null && typeof p === "object" && (p as { type?: unknown }).type === "image_url",
      ),
  );
}
