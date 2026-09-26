import stringWidth from "string-width";

/**
 * A pure, Ink-free text-editing model for the composer: a string + a caret offset, with immutable edits and
 * the wrapped-layout math needed to move the caret by VISUAL row/column and to render a window around it.
 *
 * Offsets are UTF-16 code-unit indices (the same units as String.prototype.slice), clamped to [0, text.length].
 * Caret motion steps whole code points (a surrogate pair moves/deletes as one unit); ZWJ / combining-mark
 * graphemes are out of scope (stepped by code point — same rough edge as Codex/Claude terminals). Column math
 * uses `string-width` (the exact measurer Ink 7 wraps with) so our layout agrees with Ink's rendering.
 */

/** Extra columns the composer draws before the text (the "▸ "/"  " gutter). */
const EDITOR_GUTTER = 2;

/** The usable text width inside the composer box, mirroring Composer.tsx's boxW math. The single source of
 *  truth for BOTH the key handler (caret motion) and the render, so their wrapping can never drift. */
export function composerTextWidth(width: number): number {
  const boxW = Math.max(0, Math.min(width - 2, 120)); // mirrors Composer.tsx boxW
  // reserve paddingX (2), the "▸ " gutter, and ONE column for the caret so a full-width caret row never
  // truncates the ▋ off the right edge. Floor at 1 (NOT a larger constant) so the caret reserve holds even on
  // a pathologically narrow pane — a fixed floor of 8 would exceed the text area at boxW<13 and clip the caret.
  return Math.max(1, boxW - 2 - EDITOR_GUTTER - 1);
}

export function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor) || cursor <= 0) return 0;
  if (cursor >= text.length) return text.length;
  const c = Math.floor(cursor);
  // Don't land in the middle of a surrogate pair: if the char before us is a low surrogate, step back one.
  const code = text.charCodeAt(c);
  if (code >= 0xdc00 && code <= 0xdfff) {
    const prev = text.charCodeAt(c - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) return c - 1;
  }
  return c;
}

/** Code-unit length of the code point that STARTS at `i` (2 for an astral char, else 1). */
function cpLenAt(text: string, i: number): number {
  const code = text.charCodeAt(i);
  if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
    const next = text.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return 2;
  }
  return 1;
}

/** Code-unit length of the code point that ENDS at `i` (the char before offset `i`). */
function cpLenBefore(text: string, i: number): number {
  if (i <= 0) return 0;
  const code = text.charCodeAt(i - 1);
  if (code >= 0xdc00 && code <= 0xdfff && i - 2 >= 0) {
    const prev = text.charCodeAt(i - 2);
    if (prev >= 0xd800 && prev <= 0xdbff) return 2;
  }
  return 1;
}

export function insertAt(
  text: string,
  cursor: number,
  ins: string,
): { text: string; cursor: number } {
  const c = clampCursor(text, cursor);
  return { text: text.slice(0, c) + ins + text.slice(c), cursor: c + ins.length };
}

export function deleteBackAt(text: string, cursor: number): { text: string; cursor: number } {
  const c = clampCursor(text, cursor);
  if (c === 0) return { text, cursor: 0 };
  const n = cpLenBefore(text, c);
  return { text: text.slice(0, c - n) + text.slice(c), cursor: c - n };
}

export function deleteForwardAt(text: string, cursor: number): { text: string; cursor: number } {
  const c = clampCursor(text, cursor);
  if (c >= text.length) return { text, cursor: c };
  const n = cpLenAt(text, c);
  return { text: text.slice(0, c) + text.slice(c + n), cursor: c };
}

export function moveLeft(text: string, cursor: number): number {
  const c = clampCursor(text, cursor);
  return c === 0 ? 0 : c - cpLenBefore(text, c);
}

export function moveRight(text: string, cursor: number): number {
  const c = clampCursor(text, cursor);
  return c >= text.length ? text.length : c + cpLenAt(text, c);
}

// ---- line and word editing (readline-style keys) ----

/** Start of the logical line the cursor is on. */
export function lineStart(text: string, cursor: number): number {
  const c = clampCursor(text, cursor);
  return text.lastIndexOf("\n", c - 1) + 1;
}

/** End of the logical line the cursor is on. */
export function lineEnd(text: string, cursor: number): number {
  const c = clampCursor(text, cursor);
  const nl = text.indexOf("\n", c);
  return nl < 0 ? text.length : nl;
}

/** Ctrl+U: delete from the start of the line to the cursor. */
export function deleteToLineStart(text: string, cursor: number): { text: string; cursor: number } {
  const c = clampCursor(text, cursor);
  const start = lineStart(text, c);
  return { text: text.slice(0, start) + text.slice(c), cursor: start };
}

/** Ctrl+K: delete from the cursor to the end of the line. */
export function deleteToLineEnd(text: string, cursor: number): { text: string; cursor: number } {
  const c = clampCursor(text, cursor);
  return { text: text.slice(0, c) + text.slice(lineEnd(text, c)), cursor: c };
}

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** Alt+B: the start of the word before the cursor (skipping any separators first). */
export function wordLeft(text: string, cursor: number): number {
  let c = clampCursor(text, cursor);
  while (c > 0 && !isWordChar(text[c - 1])) c--;
  while (c > 0 && isWordChar(text[c - 1])) c--;
  return c;
}

/** Alt+F: the end of the word after the cursor. */
export function wordRight(text: string, cursor: number): number {
  let c = clampCursor(text, cursor);
  while (c < text.length && !isWordChar(text[c])) c++;
  while (c < text.length && isWordChar(text[c])) c++;
  return c;
}

/** Ctrl+W: delete the word before the cursor. */
export function deleteWordBack(text: string, cursor: number): { text: string; cursor: number } {
  const c = clampCursor(text, cursor);
  const start = wordLeft(text, c);
  return { text: text.slice(0, start) + text.slice(c), cursor: start };
}

// ---- wrapped-layout math ----

export interface VisualRow {
  /** Index of the logical (\n-split) line this row belongs to. */
  logicalLine: number;
  /** Absolute code-unit offset where this row's text begins. */
  startOffset: number;
  /** Absolute code-unit offset just past this row's last char (== startOffset for an empty row). */
  endOffset: number;
  /** The row's characters (never contains a newline). */
  text: string;
}

/** Break `text` into visual rows at width `width` (char-level hard wrap by visual columns). A trailing "\n"
 *  yields a trailing empty row so the caret can sit on the blank line after a final newline. */
export function layoutRows(text: string, width: number): VisualRow[] {
  const w = Math.max(1, Math.floor(width));
  const rows: VisualRow[] = [];
  const lines = text.split("\n");
  let base = 0; // absolute offset of the start of the current logical line
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    if (line.length === 0) {
      rows.push({ logicalLine: li, startOffset: base, endOffset: base, text: "" });
    } else {
      let rowStart = base;
      let rowText = "";
      let rowWidth = 0;
      let idx = base;
      for (const ch of line) {
        const cw = stringWidth(ch);
        if (rowWidth + cw > w && rowText.length > 0) {
          rows.push({ logicalLine: li, startOffset: rowStart, endOffset: idx, text: rowText });
          rowStart = idx;
          rowText = "";
          rowWidth = 0;
        }
        rowText += ch;
        rowWidth += cw;
        idx += ch.length;
      }
      rows.push({ logicalLine: li, startOffset: rowStart, endOffset: idx, text: rowText });
    }
    base += line.length + 1; // + the "\n" that split() removed (unused past the last line)
  }
  return rows;
}

/** Visual column of a code-unit offset within a row's text (sum of char widths before it). */
function visualCol(rowText: string, unitOffset: number): number {
  if (unitOffset <= 0) return 0;
  let col = 0;
  let i = 0;
  for (const ch of rowText) {
    if (i >= unitOffset) break;
    col += stringWidth(ch);
    i += ch.length;
  }
  return col;
}

export function offsetToRowCol(rows: VisualRow[], offset: number): { row: number; col: number } {
  if (rows.length === 0) return { row: 0, col: 0 };
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as VisualRow;
    if (offset < row.endOffset && offset >= row.startOffset) {
      return { row: r, col: visualCol(row.text, offset - row.startOffset) };
    }
    if (offset === row.endOffset) {
      const next = rows[r + 1];
      // A soft-wrap boundary (the same logical line continues on the next row) maps to the NEXT row's start,
      // i.e. where the next typed char lands. A hard end (end of a logical line, or the last row) stays here.
      if (next && next.logicalLine === row.logicalLine && next.startOffset === offset) continue;
      return { row: r, col: visualCol(row.text, offset - row.startOffset) };
    }
  }
  const last = rows[rows.length - 1] as VisualRow;
  return { row: rows.length - 1, col: visualCol(last.text, last.text.length) };
}

export function rowColToOffset(rows: VisualRow[], row: number, col: number): number {
  if (rows.length === 0) return 0;
  const r = Math.max(0, Math.min(Math.floor(row), rows.length - 1));
  const vr = rows[r] as VisualRow;
  let acc = 0;
  let unit = vr.startOffset;
  for (const ch of vr.text) {
    if (acc >= col) break;
    acc += stringWidth(ch);
    unit += ch.length;
  }
  return unit;
}

// ---- width-aware motion (built on layoutRows); `width` is the wrap width (composerTextWidth) ----

export function moveUp(text: string, cursor: number, width: number, goalCol?: number): number {
  const rows = layoutRows(text, width);
  const { row, col } = offsetToRowCol(rows, clampCursor(text, cursor));
  if (row === 0) return 0; // already on the top row → jump to the very start
  return rowColToOffset(rows, row - 1, goalCol ?? col);
}

export function moveDown(text: string, cursor: number, width: number, goalCol?: number): number {
  const rows = layoutRows(text, width);
  const { row, col } = offsetToRowCol(rows, clampCursor(text, cursor));
  if (row >= rows.length - 1) return text.length; // already on the bottom row → jump to the very end
  return rowColToOffset(rows, row + 1, goalCol ?? col);
}

export function moveHome(text: string, cursor: number, width: number): number {
  const rows = layoutRows(text, width);
  const { row } = offsetToRowCol(rows, clampCursor(text, cursor));
  return (rows[row] as VisualRow).startOffset;
}

export function moveEnd(text: string, cursor: number, width: number): number {
  const rows = layoutRows(text, width);
  const { row } = offsetToRowCol(rows, clampCursor(text, cursor));
  return (rows[row] as VisualRow).endOffset;
}

/** The visual column of the caret — used to keep a goal column across a run of vertical moves. */
export function cursorGoalCol(text: string, cursor: number, width: number): number {
  const rows = layoutRows(text, width);
  return offsetToRowCol(rows, clampCursor(text, cursor)).col;
}
