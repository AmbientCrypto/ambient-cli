import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { type ModelBudgets, UNKNOWN_WINDOW, budgetsFor, profileFor } from "../src/index.js";

const m = (over: Partial<CatalogModel>): CatalogModel => ({
  id: "x/y",
  name: "y",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedFeatures: ["tools", "reasoning"],
  supportedSamplingParameters: ["temperature", "max_tokens"],
  contextLength: 131_072,
  maxOutputLength: 8_192,
  isReady: true,
  ...over,
});

const WINDOWS = [
  4_096, 8_192, 32_768, 65_536, 131_072, 202_752, 262_144, 524_288, 1_048_576, 2_097_152,
];
const KEYS: (keyof ModelBudgets)[] = [
  "desiredOutput",
  "compactReserve",
  "keepRecent",
  "toolResultMaxChars",
  "repoMapMaxTokens",
  "skillsMaxTokens",
  "instructionsPerFileChars",
  "instructionsTotalChars",
  "subagentSummaryChars",
];

describe("budgetsFor (properties over every window size)", () => {
  it("every budget is monotonic non-decreasing in the window", () => {
    for (let i = 1; i < WINDOWS.length; i++) {
      const a = budgetsFor(WINDOWS[i - 1] as number, 65_536);
      const b = budgetsFor(WINDOWS[i] as number, 65_536);
      for (const k of KEYS) expect(b[k], `${k} at ${WINDOWS[i]}`).toBeGreaterThanOrEqual(a[k]);
    }
  });
  it("token budgets never exceed the window, and the reserve + kept tokens leave room to compact", () => {
    for (const w of WINDOWS) {
      const b = budgetsFor(w, 65_536);
      expect(b.compactReserve).toBeLessThanOrEqual(Math.max(2_000, w * 0.25));
      expect(b.keepRecent).toBeLessThanOrEqual(Math.max(4_000, w));
      if (w >= 32_768) expect(b.keepRecent + b.compactReserve).toBeLessThan(w);
    }
  });
  it("a 1M-context model gets far more room than a 32K one", () => {
    const small = budgetsFor(32_768, 8_192);
    const huge = budgetsFor(1_048_576, 65_536);
    expect(huge.keepRecent).toBeGreaterThan(10 * small.keepRecent);
    expect(huge.toolResultMaxChars).toBeGreaterThan(5 * small.toolResultMaxChars);
    expect(huge.desiredOutput).toBeGreaterThan(small.desiredOutput);
  });
  it("the per-turn output ask never exceeds the model's output cap", () => {
    for (const w of WINDOWS) expect(budgetsFor(w, 2_048).desiredOutput).toBeLessThanOrEqual(2_048);
  });
});

describe("profileFor", () => {
  it("reads everything from the catalog entry", () => {
    const p = profileFor("q/vl", m({ inputModalities: ["text", "image"], contextLength: 32_768 }));
    expect(p.window).toBe(32_768);
    expect(p.vision).toBe(true);
    expect(p.declaresTools).toBe(true);
    expect(p.reasoning).toBe(true);
    expect(p.samplingParams.has("temperature")).toBe(true);
    expect(p.estimated).toBe(false);
  });
  it("a learned ceiling lowers the window (never raises it)", () => {
    expect(profileFor("a", m({ contextLength: 200_000 }), { ceiling: 90_000 }).window).toBe(90_000);
    expect(profileFor("a", m({ contextLength: 60_000 }), { ceiling: 90_000 }).window).toBe(60_000);
  });
  it("an unknown model or missing fields → conservative, flagged as estimated", () => {
    const p = profileFor("gone/model", undefined);
    expect(p.window).toBe(UNKNOWN_WINDOW);
    expect(p.estimated).toBe(true);
    expect(p.vision).toBe(false);
    expect(profileFor("a", m({ contextLength: undefined })).estimated).toBe(true);
  });
  it("future modalities pass through untouched", () => {
    const p = profileFor("v/omni", m({ inputModalities: ["text", "image", "video", "audio"] }));
    expect(p.inputModalities).toEqual(["text", "image", "video", "audio"]);
  });
  it("the output cap is bounded by the window", () => {
    expect(profileFor("a", m({ contextLength: 8_000, maxOutputLength: 200_000 })).outputCap).toBe(
      8_000,
    );
  });
});

describe("tiny windows", () => {
  it("kept history plus the compaction reserve always fit inside the window", () => {
    for (const w of [2_048, 4_096, 8_192, 16_384]) {
      const b = budgetsFor(w, 1_024);
      expect(b.keepRecent + b.compactReserve, String(w)).toBeLessThanOrEqual(w);
    }
  });
});
