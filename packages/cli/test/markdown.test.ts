import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { type InlineSpan, parseInline, renderMarkdown } from "../src/tui/markdown.js";

// A compact view of a parsed span for assertions.
const shape = (s: InlineSpan) => ({
  text: s.text,
  ...(s.bold ? { bold: true } : {}),
  ...(s.italic ? { italic: true } : {}),
  ...(s.code ? { code: true } : {}),
  ...(s.href ? { href: s.href } : {}),
});

describe("parseInline", () => {
  it("parses bold, italic, inline code, and links", () => {
    expect(parseInline("a **b** c").map(shape)).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c" },
    ]);
    expect(parseInline("x *y* z").map(shape)).toEqual([
      { text: "x " },
      { text: "y", italic: true },
      { text: " z" },
    ]);
    expect(parseInline("run `npm test` now").map(shape)).toEqual([
      { text: "run " },
      { text: "npm test", code: true },
      { text: " now" },
    ]);
    expect(parseInline("see [docs](https://x.io)").map(shape)).toEqual([
      { text: "see " },
      { text: "docs", href: "https://x.io" },
    ]);
  });

  it("leaves an UNCLOSED marker literal (mid-stream safety)", () => {
    expect(parseInline("half **bold").map(shape)).toEqual([{ text: "half **bold" }]);
    expect(parseInline("a `code").map(shape)).toEqual([{ text: "a `code" }]);
  });

  it("does NOT italicize snake_case identifiers (no underscore emphasis)", () => {
    expect(parseInline("call some_long_name here").map(shape)).toEqual([
      { text: "call some_long_name here" },
    ]);
  });

  it("keeps inline code content literal (no nested parsing)", () => {
    expect(parseInline("`a **b** c`").map(shape)).toEqual([{ text: "a **b** c", code: true }]);
  });

  it("prefers bold over italic for `**`", () => {
    expect(parseInline("**strong**").map(shape)).toEqual([{ text: "strong", bold: true }]);
  });
});

describe("renderMarkdown (frame content)", () => {
  const frame = (md: string, width = 60) => {
    const { lastFrame, unmount } = render(renderMarkdown(md, width) as never);
    const out = lastFrame() ?? "";
    unmount();
    return out;
  };

  it("renders bold/inline-code without showing the raw markers", () => {
    const out = frame("This is **important** and `code`.");
    expect(out).toContain("important");
    expect(out).toContain("code");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
  });

  it("renders a header without the leading #", () => {
    const out = frame("# Audit Report");
    expect(out).toContain("Audit Report");
    expect(out).not.toContain("# Audit");
  });

  it("renders bullet lists with a bullet glyph, not the raw dash", () => {
    const out = frame("- first\n- second");
    expect(out).toContain("first");
    expect(out).toContain("second");
    expect(out).toContain("•");
  });

  it("renders a code fence's contents without the ``` delimiters", () => {
    const out = frame("```ts\nconst x = 1;\n```");
    expect(out).toContain("const x = 1;");
    expect(out).not.toContain("```");
  });

  it("renders a table's cells and drops the |---| separator row", () => {
    const out = frame("| Sev | Count |\n| --- | --- |\n| Bug | 3 |", 40);
    expect(out).toContain("Sev");
    expect(out).toContain("Count");
    expect(out).toContain("Bug");
    expect(out).toContain("3");
    expect(out).not.toContain("---");
  });

  it("breaks a very long unbroken token so it can't spill past the width", () => {
    const out = frame(`a ${"x".repeat(200)} b`, 40);
    // hardWrap chunked the 200-char run to ~40 — no single line carries a long unbroken run off the edge.
    expect(out).not.toMatch(/x{60}/);
  });
});
