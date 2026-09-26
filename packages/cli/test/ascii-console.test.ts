import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { needsAsciiFallback, toAsciiGlyphs } from "../src/tui/ascii-console.js";

describe("legacy Windows console fallback", () => {
  it("swaps UI glyphs for one-column ASCII so the layout width is unchanged", () => {
    const s = "╭──╮ ✓ done · ⠋⠙ ▕██▍░▏ ⚠ note…";
    const a = toAsciiGlyphs(s);
    expect(/[^\x20-\x7e]/.test(a)).toBe(false);
    expect(stringWidth(a)).toBe(stringWidth(s));
  });
  it("is on only for the legacy Windows console (or when forced)", () => {
    expect(needsAsciiFallback({}, "win32")).toBe(true);
    expect(needsAsciiFallback({ WT_SESSION: "x" }, "win32")).toBe(false);
    expect(needsAsciiFallback({ TERM_PROGRAM: "vscode" }, "win32")).toBe(false);
    expect(needsAsciiFallback({}, "darwin")).toBe(false);
    expect(needsAsciiFallback({ AMBIENT_ASCII: "1" }, "darwin")).toBe(true);
  });
});
