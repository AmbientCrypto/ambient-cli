/**
 * `@` file mentions in the composer: the word being typed at the cursor when it starts with `@` (at the start
 * of the input or after whitespace), and replacing it with the chosen path.
 */
export interface Mention {
  /** Offset of the `@`. */
  start: number;
  /** What follows the `@` up to the cursor. */
  query: string;
}

export function activeMention(text: string, cursor: number): Mention | undefined {
  const before = text.slice(0, cursor);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return undefined;
  const start = before.length - (m[2] ?? "").length - 1;
  // Only while the cursor is at the end of that word (not in the middle of an existing one).
  const after = text[cursor];
  if (after !== undefined && !/\s/.test(after)) return undefined;
  return { start, query: m[2] ?? "" };
}

/** Replace the mention being typed with `@path ` and put the cursor after it. */
export function insertMention(
  text: string,
  cursor: number,
  mention: Mention,
  path: string,
): { text: string; cursor: number } {
  const ins = `@${path} `;
  const next = text.slice(0, mention.start) + ins + text.slice(cursor).replace(/^ /, "");
  return { text: next, cursor: mention.start + ins.length };
}
