/**
 * Shared, pure hunk-application logic for the `edit` (single) and `apply_patch` (multi-file) tools — one place
 * that enforces the conflict-safe contract: an exact `oldString` that must match UNIQUELY (unless replaceAll),
 * never a fuzzy/guessed match. Both tools apply the SAME primitive so their behavior can never diverge.
 */

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

/** True when every line break in `text` is CRLF (a Windows-style file) — mixed files are left exact. */
export function isCrlf(text: string): boolean {
  const lf = (text.match(/\n/g) ?? []).length;
  return lf > 0 && (text.match(/\r\n/g) ?? []).length === lf;
}

/** Give LF text the line endings of `like` (CRLF when `like` is a consistently-CRLF file). */
export function matchLineEndings(text: string, like: string): string {
  return isCrlf(like) ? text.replace(/\r?\n/g, "\r\n") : text;
}

export interface HunkResult {
  content: string;
  replacements: number;
}

/**
 * Apply one exact-substring hunk to `content`. Throws (with a `label`, e.g. the file path) on: identical
 * old/new, not-found, or a non-unique match without replaceAll — so a hunk can never silently mis-apply.
 */
export function applyHunk(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  label: string,
): HunkResult {
  // A CRLF file (Windows checkout) is edited in LF — the model writes `\n` — and converted back, so a
  // multi-line match works and inserted lines don't produce mixed line endings.
  if (isCrlf(content)) {
    const lf = (s: string) => s.replace(/\r\n/g, "\n");
    const r = applyHunk(lf(content), lf(oldString), lf(newString), replaceAll, label);
    return { content: r.content.replace(/\n/g, "\r\n"), replacements: r.replacements };
  }
  if (oldString === newString) {
    throw new Error(`oldString and newString are identical (${label})`);
  }
  const count = countOccurrences(content, oldString);
  if (count === 0) throw new Error(`oldString not found in ${label}`);
  if (count > 1 && !replaceAll) {
    throw new Error(
      `oldString is not unique in ${label} (${count} matches); set replaceAll or add surrounding context`,
    );
  }
  const next = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, () => newString); // a function, so `$&`/`$$` in the new text stay literal
  return { content: next, replacements: replaceAll ? count : 1 };
}
