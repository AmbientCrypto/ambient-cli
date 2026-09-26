import { describe, expect, it } from "vitest";
import {
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBack,
  lineEnd,
  lineStart,
  wordLeft,
  wordRight,
} from "../src/tui/editor.js";

describe("readline-style editing", () => {
  const text = "first line\nfix the parser now";
  const onSecond = text.indexOf("parser") + 3; // inside "parser"
  it("finds the current line's start and end", () => {
    expect(lineStart(text, onSecond)).toBe(11);
    expect(lineEnd(text, onSecond)).toBe(text.length);
    expect(lineEnd(text, 3)).toBe(10);
  });
  it("Ctrl+U / Ctrl+K cut to the start / end of the current line only", () => {
    expect(deleteToLineStart(text, onSecond)).toEqual({
      text: "first line\nser now",
      cursor: 11,
    });
    expect(deleteToLineEnd(text, onSecond).text).toBe("first line\nfix the par");
  });
  it("Alt+B / Alt+F move by words and Ctrl+W deletes the previous word", () => {
    expect(wordLeft(text, onSecond)).toBe(text.indexOf("parser"));
    expect(wordRight(text, onSecond)).toBe(text.indexOf("parser") + 6);
    expect(deleteWordBack("run the tests  ", 15)).toEqual({ text: "run the ", cursor: 8 });
    expect(deleteWordBack("", 0)).toEqual({ text: "", cursor: 0 });
  });
});
