import stringWidth from "string-width";

/**
 * Display-width-correct clipping. Terminal columns are not string length: a CJK character or most emoji take
 * two columns, a combining mark zero. These measure with `string-width` (the same measurer Ink wraps with), so
 * a clipped row never overflows its column.
 */

/** The longest prefix of `text` that fits in `max` columns (never splits a code point). */
export function sliceToWidth(text: string, max: number): string {
  if (max <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (used + w > max) break;
    out += ch;
    used += w;
  }
  return out;
}

/** Flatten newlines and truncate to `max` columns with an ellipsis. */
export function clipText(text: string, max: number): string {
  const t = text.replace(/\s*\n\s*/g, " ");
  if (max <= 1) return t.length > 0 ? "…" : "";
  return stringWidth(t) <= max ? t : `${sliceToWidth(t, max - 1)}…`;
}

export { stringWidth };
