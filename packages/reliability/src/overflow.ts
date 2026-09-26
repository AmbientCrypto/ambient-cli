/**
 * Context-overflow handling. Clean-room from bridge_policy.py (MIT).
 *
 * When a request genuinely exceeds the model's window, we synthesize the exact phrasing the compactor
 * recognizes so the agent compacts and replays. Crucially, we must NOT treat image/param/schema 400s
 * as overflow — misclassifying those would trigger pointless compaction loops.
 */

export function synthesizeOverflow(promptTokens: number, maxTokens: number): string {
  return `prompt is too long: ${promptTokens} tokens > ${maxTokens} maximum`;
}

const OVERFLOW_RE =
  /prompt is too long|context[ _]length|maximum context|context window|too many tokens|longer than the model|maximum input length/i;
/** Param/schema 400s that can mention limits but are NOT a window overflow (compaction would not help). */
const NOT_OVERFLOW_RE = /unsupported parameter|temperature|content_policy/i;
/** Image-specific rejections — only meaningful when the request actually carried images. */
const IMAGE_ERROR_RE = /image|vision|multimodal/i;

/**
 * True only for a real context overflow — never for image/param/schema 400s. A generic "invalid request:"
 * wrapper around a genuine overflow still counts. A request with images CAN overflow (images cost tokens);
 * it's only excluded when the message is about the image itself.
 */
export function isContextOverflowError(body: string, opts: { hasImage?: boolean } = {}): boolean {
  if (!OVERFLOW_RE.test(body) || NOT_OVERFLOW_RE.test(body)) return false;
  if (opts.hasImage && IMAGE_ERROR_RE.test(body)) return false;
  return true;
}

/** The REAL max token count a provider reported in an overflow message ("… > N maximum"), if present —
 *  so we can learn the model's true (lower-than-catalog) ceiling. Returns undefined if unparseable. */
export function parseOverflowMax(body: string): number | undefined {
  const m = body.match(/>\s*([0-9][0-9,_ ]{2,})\s*(?:maximum|max|tokens|token)?/i);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(/[,_ ]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
