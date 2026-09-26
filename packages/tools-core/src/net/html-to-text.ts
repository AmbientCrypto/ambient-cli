/**
 * A small, dependency-free HTML→text extractor for `web_fetch`. Not a full DOM: it strips script/style/head
 * noise, turns block boundaries into newlines, removes remaining tags, decodes common entities, and collapses
 * whitespace — enough to hand a model READABLE page content instead of markup. All patterns are linear-time
 * (no nested quantifiers) so a hostile page can't cause catastrophic backtracking.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

/** Decode the handful of entities that actually show up in body text; leave anything unknown as-is. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10}|#\d{1,7});/g, (whole, body) => {
    const b = body as string;
    if (b[0] === "#") {
      const isHex = b[1] === "x" || b[1] === "X";
      const code = Number.parseInt(isHex ? b.slice(2) : b.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[b.toLowerCase()];
    return named ?? whole;
  });
}

/** Extract the document <title>, decoded + trimmed, or undefined. */
export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]{0,2000}?)<\/title>/i);
  if (!m) return undefined;
  const t = decodeEntities(m[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t === "" ? undefined : t;
}

/** Elements whose CONTENT is dropped entirely (scripts, styles, head metadata, inline SVG, …). */
const NOISE_TAGS = new Set(["script", "style", "head", "noscript", "template", "svg"]);
/** Elements that force a line break at their boundary so the text keeps its structure. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "section",
  "article",
  "header",
  "footer",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "table",
  "figure",
  "main",
  "nav",
  "aside",
  "br",
]);
/** Hard cap on the HTML we'll scan — the output is capped far below this anyway, and it bounds worst-case work. */
export const MAX_HTML_INPUT_CHARS = 2_000_000;

function isNameChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
}

/**
 * Convert an HTML document to readable plain text with a SINGLE LINEAR pass (no backtracking regex — a
 * hostile page of unbalanced `<` used to make this O(n²)). It never re-scans: every index only
 * moves forward, so total work is O(n).
 */
export function htmlToText(html: string): string {
  const src = html.length > MAX_HTML_INPUT_CHARS ? html.slice(0, MAX_HTML_INPUT_CHARS) : html;
  const lower = src.toLowerCase(); // computed ONCE — reused by every noise-block skip (keeps the pass O(n))
  const n = src.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    if (src[i] !== "<") {
      const lt = src.indexOf("<", i);
      const end = lt === -1 ? n : lt;
      out.push(src.slice(i, end));
      i = end;
      continue;
    }
    // A comment or CDATA — skip to its terminator.
    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    // Read the tag name (after an optional leading '/').
    let j = i + 1;
    if (src[j] === "/") j++;
    const nameStart = j;
    while (j < n && isNameChar(src[j] as string)) j++;
    const name = src.slice(nameStart, j).toLowerCase();
    const gt = src.indexOf(">", j);
    if (gt === -1) {
      // Unterminated tag: drop the rest (a stray '<' with no '>' is malformed) and stop.
      break;
    }
    const isOpen = src[i + 1] !== "/";
    if (isOpen && NOISE_TAGS.has(name)) {
      // Skip the element's entire content up to its close tag (linear indexOf, never re-scanned).
      const closeIdx = indexOfCloseTag(src, lower, name, gt + 1);
      i = closeIdx === -1 ? n : closeIdx;
      continue;
    }
    // One line break per block boundary: on a block's CLOSE tag, or on <br> (which has no close).
    if (name === "br" || (!isOpen && BLOCK_TAGS.has(name))) out.push("\n");
    i = gt + 1;
  }

  let s = decodeEntities(out.join(""));
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n"); // collapse runs of blank lines
  return s.trim();
}

/** Find the index just past `</name ...>` at or after `from`, or -1. Case-insensitive, linear.
 *  `lower` is the pre-lowercased `src` (computed once by the caller) so repeated calls stay O(n) overall. */
function indexOfCloseTag(src: string, lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  let k = from;
  while (true) {
    const at = lower.indexOf(needle, k);
    if (at === -1) return -1;
    const after = at + needle.length;
    // The char after the name must not continue an identifier (so </script> matches, </scripting> doesn't).
    if (!isNameChar(src[after] ?? "")) {
      const gt = src.indexOf(">", after);
      return gt === -1 ? -1 : gt + 1;
    }
    k = after;
  }
}
