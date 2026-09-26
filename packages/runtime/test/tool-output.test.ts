import { toolResultCharBudget } from "@amb/context";
import { budgetFromCatalog } from "@amb/context";
import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { MAX_TOOL_RESULT_CHARS, capToolResult } from "../src/agent-support.js";

const utf8 = (s: string) => new TextEncoder().encode(s).length;

describe("capToolResult (byte-based, marker-inside-cap, NaN-safe)", () => {
  it("returns short text unchanged", () => {
    expect(capToolResult("hello", 1000)).toBe("hello");
  });

  it("caps by UTF-8 BYTES, not UTF-16 length — CJK is budgeted like the tokenizer sees it", () => {
    const cjk = "あ".repeat(1000); // 1000 chars but 3000 UTF-8 bytes
    const out = capToolResult(cjk, 600); // 600-byte budget
    expect(out).toContain("bytes truncated");
    // Output stays within the cap (+ a small marker reserve), NOT ~3× over as a .length cap would allow.
    expect(utf8(out)).toBeLessThanOrEqual(700);
  });

  it("reserves the marker INSIDE the cap (total output ≤ cap, not cap + marker)", () => {
    const out = capToolResult("x".repeat(5000), 1500);
    expect(utf8(out)).toBeLessThanOrEqual(1500);
    expect(out).toContain("bytes truncated");
  });

  it("a non-finite budget falls back to the default cap (never emits 'NaN')", () => {
    const out = capToolResult("x".repeat(MAX_TOOL_RESULT_CHARS + 5000), Number.NaN);
    expect(out).not.toContain("NaN");
    expect(utf8(out)).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("truncation of multi-byte text must be detected by IDENTITY, not a UTF-16 length compare", () => {
    const cjk = "界".repeat(501); // 1503 UTF-8 bytes
    const out = capToolResult(cjk, 1500); // truncates by BYTES and inserts a "…[N bytes truncated]…" marker
    expect(out).not.toBe(cjk); // identity check → truncation IS seen (this is what the offload now uses)
    // The old `capped.length < fullText.length` offload guard would MISS this: the marker can push the capped
    // UTF-16 length to >= the original for multi-byte content, so a length compare silently drops the offload.
    expect(out.length).toBeGreaterThanOrEqual(cjk.length);
  });
});

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: "m",
  name: "m",
  inputModalities: [],
  outputModalities: [],
  supportedFeatures: [],
  supportedSamplingParameters: [],
  contextLength: 32_768,
  ...over,
});

describe("toolResultCharBudget — NaN-safe", () => {
  it("a NaN prompt estimate is normalized (treated as 0), never propagates NaN", () => {
    const b = budgetFromCatalog(model());
    const v = toolResultCharBudget(b, Number.NaN);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(toolResultCharBudget(b, 0)); // NaN ⇒ 0 remaining-prompt
  });
});
