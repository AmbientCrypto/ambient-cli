import { describe, expect, it } from "vitest";
import { applyHunk } from "../src/patch.js";

describe("CRLF files (Windows checkouts)", () => {
  const crlf = "function a() {\r\n  return 1;\r\n}\r\n";
  it("a multi-line LF oldString matches a CRLF file and the result stays CRLF", () => {
    const r = applyHunk(crlf, "  return 1;\n}", "  return 2;\n}", false, "a.ts");
    expect(r.content).toBe("function a() {\r\n  return 2;\r\n}\r\n");
  });
  it("new lines inserted into a CRLF file get CRLF too (no mixed endings)", () => {
    const r = applyHunk(crlf, "  return 1;", "  const x = 1;\n  return x;", false, "a.ts");
    expect(r.content).toBe("function a() {\r\n  const x = 1;\r\n  return x;\r\n}\r\n");
    expect(/[^\r]\n/.test(r.content)).toBe(false);
  });
  it("an LF file is untouched by the normalization", () => {
    expect(applyHunk("a\nb\n", "a\nb", "a\nc", false, "f").content).toBe("a\nc\n");
  });
  it("a mixed-ending file keeps exact matching (never rewritten wholesale)", () => {
    const mixed = "a\r\nb\nc\r\n";
    expect(applyHunk(mixed, "b", "B", false, "f").content).toBe("a\r\nB\nc\r\n");
  });
});

describe("line-ending helpers", () => {
  it("matchLineEndings converts only for consistently-CRLF targets", async () => {
    const { matchLineEndings } = await import("../src/patch.js");
    expect(matchLineEndings("a\nb\n", "x\r\ny\r\n")).toBe("a\r\nb\r\n");
    expect(matchLineEndings("a\nb\n", "x\ny\n")).toBe("a\nb\n");
  });
});

describe("applyHunk keeps the new text literal", () => {
  it("does not expand $-patterns such as $$, $& or $'", () => {
    const next = "echo $$ $& x=$'\\n' $`";
    expect(applyHunk("old line\n", "old line", next, false, "f").content).toBe(`${next}\n`);
  });
});
