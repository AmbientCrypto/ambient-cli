/**
 * Force a hard break inside any unbroken run longer than `width`. Ink's `wrap="wrap"` only breaks on
 * whitespace, so a long token with no spaces (a JSON blob, a long path/URL, a minified line) spills off the
 * right edge. Inserting a newline every `width` chars into such runs guarantees the line fits the terminal
 * while leaving normal prose (which has spaces) to wrap naturally.
 */
export function hardWrap(text: string, width: number): string {
  const w = Math.max(8, width);
  return text.replace(new RegExp(`\\S{${w + 1},}`, "gu"), (run) => {
    // Chunk by CODE POINTS (Array.from), never by UTF-16 code units, so a surrogate pair (emoji, non-BMP
    // glyph) is never torn across the break into two lone surrogates (which render as garbage �).
    const cps = Array.from(run);
    const parts: string[] = [];
    for (let i = 0; i < cps.length; i += w) parts.push(cps.slice(i, i + w).join(""));
    return parts.join("\n");
  });
}
