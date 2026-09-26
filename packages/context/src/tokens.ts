/**
 * Conservative token estimation. We do NOT trust a universal chars-per-token constant across models
 * (Karpathy's tokenizer lesson). Until a model-specific tokenizer is wired, we estimate on BYTES —
 * safer than chars for code/multilingual content — and round UP so we never under-budget.
 *
 * A per-model `charsPerToken` (learned from real usage) can override the default when available.
 */

export const DEFAULT_BYTES_PER_TOKEN = 3.5;
/** Fallback token cost of one image content-part when no resolver is given. Images are billed by tile, NOT by
 *  their (huge) base64 length. Conservative (measured a real image at ~1655 tok) — the agent threads an
 *  accurate per-image cost from the served window's plan; this default only backstops an un-planned estimate. */
export const DEFAULT_IMAGE_TOKENS = 1800;

export function estimateTokens(text: string, opts: { bytesPerToken?: number } = {}): number {
  const bpt = opts.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN;
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / bpt);
}

/** Token cost of one message's content — a string by bytes, a content-parts ARRAY by (text bytes + image tiles),
 *  NEVER by the base64 length of an image part. `imageTokens` lets a caller size images from the served model. */
function contentTokens(
  content: unknown,
  opts: { bytesPerToken?: number },
  imageTokens: (part: unknown) => number,
): number {
  if (typeof content === "string") return estimateTokens(content, opts);
  if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content ?? ""), opts);
  let total = 0;
  for (const part of content) {
    if (part !== null && typeof part === "object") {
      const type = (part as { type?: unknown }).type;
      if (type === "image_url" || type === "image") {
        total += imageTokens(part);
        continue;
      }
      const text = (part as { text?: unknown }).text;
      if (type === "text" && typeof text === "string") {
        total += estimateTokens(text, opts);
        continue;
      }
    }
    total += estimateTokens(JSON.stringify(part ?? ""), opts); // unknown part — bounded fallback
  }
  return total;
}

/**
 * Estimate tokens for a set of chat messages, adding a small per-message framing overhead. Counts
 * assistant `toolCalls` too — a tool-call turn's tokens live there, not in `content`. An image
 * content-part is counted via `imageTokens` (default DEFAULT_IMAGE_TOKENS), never as its base64 text.
 */
export function estimateMessagesTokens(
  messages: { role: string; content?: unknown; toolCalls?: unknown }[],
  opts: {
    bytesPerToken?: number;
    perMessageOverhead?: number;
    imageTokens?: (part: unknown) => number;
  } = {},
): number {
  const overhead = opts.perMessageOverhead ?? 4;
  const imageTokens = opts.imageTokens ?? (() => DEFAULT_IMAGE_TOKENS);
  let total = 0;
  for (const m of messages) {
    total += contentTokens(m.content, opts, imageTokens) + estimateTokens(m.role, opts) + overhead;
    if (m.toolCalls !== undefined) total += estimateTokens(JSON.stringify(m.toolCalls), opts);
  }
  return total;
}
