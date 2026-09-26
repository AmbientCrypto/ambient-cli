import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { clipText, sliceToWidth } from "../src/tui/clip.js";

describe("width-correct clipping", () => {
  it("clips wide (CJK/emoji) text by COLUMNS, never overflowing", () => {
    const out = clipText("修复这个解析器的错误并运行测试", 10);
    expect(stringWidth(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
  it("leaves text that fits untouched and never splits a code point", () => {
    expect(clipText("short", 10)).toBe("short");
    expect(sliceToWidth("a😀b", 2)).toBe("a");
  });
});
