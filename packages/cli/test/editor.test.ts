import { describe, expect, it } from "vitest";
import {
  clampCursor,
  composerTextWidth,
  deleteBackAt,
  deleteForwardAt,
  insertAt,
  layoutRows,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  offsetToRowCol,
  rowColToOffset,
} from "../src/tui/editor.js";

const EMOJI = "😀"; // one astral code point = 2 UTF-16 units

describe("editor — width-independent edits", () => {
  it("inserts at the caret and advances it", () => {
    expect(insertAt("ac", 1, "b")).toEqual({ text: "abc", cursor: 2 });
    expect(insertAt("", 0, "hi")).toEqual({ text: "hi", cursor: 2 });
    expect(insertAt("ab", 99, "!")).toEqual({ text: "ab!", cursor: 3 }); // clamps past end
  });

  it("inserts a multi-line paste at the caret", () => {
    expect(insertAt("start end", 6, "MID\nMORE ")).toEqual({
      text: "start MID\nMORE end",
      cursor: 15,
    });
  });

  it("backspace deletes the char before the caret (a full code point for an emoji)", () => {
    expect(deleteBackAt("abc", 2)).toEqual({ text: "ac", cursor: 1 });
    expect(deleteBackAt("abc", 0)).toEqual({ text: "abc", cursor: 0 }); // no-op at start
    expect(deleteBackAt(`x${EMOJI}y`, 3)).toEqual({ text: "xy", cursor: 1 }); // removes both units
  });

  it("forward-delete removes the char AT the caret without moving it", () => {
    expect(deleteForwardAt("abc", 1)).toEqual({ text: "ac", cursor: 1 });
    expect(deleteForwardAt("abc", 3)).toEqual({ text: "abc", cursor: 3 }); // no-op at end
    expect(deleteForwardAt(`x${EMOJI}y`, 1)).toEqual({ text: "xy", cursor: 1 }); // removes both units
  });

  it("clampCursor normalizes out-of-range + mid-surrogate offsets", () => {
    expect(clampCursor("abc", -5)).toBe(0);
    expect(clampCursor("abc", 99)).toBe(3);
    expect(clampCursor(`x${EMOJI}`, 2)).toBe(1); // 2 is mid-surrogate → step back to before the pair
  });

  it("moveLeft/moveRight step whole code points", () => {
    expect(moveLeft("abc", 2)).toBe(1);
    expect(moveLeft("abc", 0)).toBe(0);
    expect(moveRight("abc", 1)).toBe(2);
    expect(moveRight("abc", 3)).toBe(3);
    expect(moveRight(`${EMOJI}z`, 0)).toBe(2); // steps over the surrogate pair
    expect(moveLeft(`${EMOJI}z`, 2)).toBe(0);
  });
});

describe("editor — wrapped layout", () => {
  it("one short line is one row", () => {
    const rows = layoutRows("hello", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ logicalLine: 0, startOffset: 0, endOffset: 5, text: "hello" });
  });

  it("wraps a long line by visual width with correct offsets", () => {
    const rows = layoutRows("abcdef", 3);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ startOffset: 0, endOffset: 3, text: "abc" });
    expect(rows[1]).toMatchObject({ startOffset: 3, endOffset: 6, text: "def" });
  });

  it("keeps blank logical lines and a trailing-newline row", () => {
    const rows = layoutRows("a\n\nb", 10);
    expect(rows.map((r) => r.text)).toEqual(["a", "", "b"]);
    const trailing = layoutRows("a\n", 10);
    expect(trailing.map((r) => r.text)).toEqual(["a", ""]); // caret can sit on the line after the newline
  });

  it("wraps CJK by visual columns (width 2 each)", () => {
    const rows = layoutRows("中文字", 4); // each glyph is width 2 → 2 per row
    expect(rows.map((r) => r.text)).toEqual(["中文", "字"]);
  });

  it("offsetToRowCol <-> rowColToOffset round-trip over every offset", () => {
    const text = "abcdef\nxy\n\nZ";
    const rows = layoutRows(text, 3);
    for (let off = 0; off <= text.length; off++) {
      // skip mid-surrogate offsets (none here) — all offsets are valid caret positions
      const { row, col } = offsetToRowCol(rows, off);
      const back = rowColToOffset(rows, row, col);
      // round-trip lands on the same VISUAL position (offset, unless it's a soft-wrap boundary that both
      // rows can represent — then back maps to the canonical row's offset for that column)
      const { row: r2, col: c2 } = offsetToRowCol(rows, back);
      expect({ r2, c2 }).toEqual({ r2: row, c2: col });
    }
  });
});

describe("editor — vertical + line motion", () => {
  const W = 80;
  it("moveUp/moveDown move by visual row and clamp at the ends", () => {
    const text = "line one\nline two\nline three";
    const c = text.indexOf("two"); // somewhere on the middle line
    const up = moveUp(text, c, W);
    expect(up).toBeLessThan(text.indexOf("\n")); // lands on the first line
    const down = moveDown(text, c, W);
    expect(down).toBeGreaterThan(text.lastIndexOf("\n")); // lands on the last line
    expect(moveUp(text, 3, W)).toBe(0); // already top → start
    expect(moveDown(text, text.length - 2, W)).toBe(text.length); // already bottom → end
  });

  it("moveUp preserves the goal column onto a longer line", () => {
    const text = "short\nmuch longer line here";
    const cursor = text.length - 1; // near the end of the long 2nd line
    const col = 20;
    const up = moveUp(text, cursor, W, col); // goal col 20 but line 1 is only 5 wide → clamp to end of "short"
    expect(up).toBe("short".length);
  });

  it("moveHome/moveEnd land at the visual row bounds", () => {
    const text = "hello world";
    const rows = layoutRows(text, 5); // "hello" / " worl" / "d"
    expect(rows.length).toBeGreaterThan(1);
    const mid = 8; // inside the 2nd visual row
    expect(moveHome(text, mid, 5)).toBe((rows[1] as { startOffset: number }).startOffset);
    expect(moveEnd(text, mid, 5)).toBe((rows[1] as { endOffset: number }).endOffset);
  });
});

describe("editor — composerTextWidth", () => {
  it("mirrors the composer box math and reserves paddingX + gutter + a caret column", () => {
    expect(composerTextWidth(80)).toBe(Math.min(80 - 2, 120) - 2 - 2 - 1); // paddingX + gutter + caret col
    expect(composerTextWidth(400)).toBe(120 - 2 - 2 - 1); // caps at 120-wide box
    // The caret-reserve invariant holds at EVERY width (usable + the ▋ column ≤ the box text area = boxW-4),
    // including pathologically narrow panes where a fixed floor of 8 would have overflowed the caret.
    for (let w = 4; w <= 40; w++) {
      const boxW = Math.max(0, Math.min(w - 2, 120));
      const textArea = Math.max(0, boxW - 4); // paddingX(2) + gutter(2)
      expect(composerTextWidth(w) + 1).toBeLessThanOrEqual(Math.max(2, textArea));
    }
  });
});
