import { type ViewState, isSettled } from "./state.js";

export const VIEW_ITEM_LIMIT = 500;
export const VIEW_BYTE_LIMIT = 8 * 1024 * 1024;
export const PREVIEW_BYTES = 64 * 1024;
export const PROMPT_COUNT_LIMIT = 500;
export const PROMPT_BYTE_LIMIT = 1024 * 1024;
const DISPLAY_FIELDS = new Set(["text", "preview", "resultPreview", "diff", "summary", "error"]);

/** Only already-printed, settled prefixes may be released. Native scrollback owns their display. */
export function acknowledgePrinted(state: ViewState, throughId: string): ViewState {
  const end = state.transcript.findIndex((item) => item.id === throughId) + 1;
  if (end === 0 || state.transcript.slice(0, end).some((item) => !isSettled(item))) return state;
  const printed = state.transcript.slice(0, end);
  if (end < VIEW_ITEM_LIMIT && Buffer.byteLength(JSON.stringify(printed)) < VIEW_BYTE_LIMIT)
    return state;
  return {
    ...state,
    transcript: state.transcript.slice(end),
    scrollbackEpoch: (state.scrollbackEpoch ?? 0) + 1,
  };
}

function clip(text: string): string {
  if (Buffer.byteLength(text) <= PREVIEW_BYTES) return text;
  return `${Buffer.from(text).subarray(0, PREVIEW_BYTES).toString("utf8")}\n… [display clipped]`;
}

/** A single unbroken paragraph must not defeat the item-count budget. Durable events remain untouched. */
export function boundView(state: ViewState): ViewState {
  const transcript = state.transcript.map((item) => {
    const fields = Object.entries(item);
    const clipped = fields.map(([key, value]) => [
      key,
      DISPLAY_FIELDS.has(key) && typeof value === "string" ? clip(value) : value,
    ]);
    return fields.some(([, value], i) => value !== clipped[i]?.[1])
      ? (Object.fromEntries(clipped) as typeof item)
      : item;
  });
  return transcript.some((item, i) => item !== state.transcript[i])
    ? { ...state, transcript }
    : state;
}

export function boundPrompts(entries: readonly string[]): string[] {
  let kept: string[] = [];
  let bytes = 0;
  for (const text of entries.slice(-PROMPT_COUNT_LIMIT).reverse()) {
    const size = Buffer.byteLength(text);
    if (bytes + size > PROMPT_BYTE_LIMIT) break;
    bytes += size;
    kept = [text, ...kept];
  }
  return kept;
}
