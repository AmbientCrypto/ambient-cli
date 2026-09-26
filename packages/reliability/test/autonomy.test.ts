import { describe, expect, it } from "vitest";
import { MIN_RUNS_FOR_TRUST, autonomyCap } from "../src/autonomy.js";

describe("autonomyCap — earned per-model autonomy", () => {
  const base = 25;
  it("stays neutral with no history or too few runs", () => {
    expect(autonomyCap(base)).toBe(base);
    expect(autonomyCap(base, { runs: MIN_RUNS_FOR_TRUST - 1, firstTryPasses: 0 })).toBe(base);
    expect(autonomyCap(base, { runs: 0, firstTryPasses: 0 })).toBe(base);
  });
  it("doubles the cap for a model that reliably passes first-try (≥80%)", () => {
    expect(autonomyCap(base, { runs: 10, firstTryPasses: 9 })).toBe(base * 2);
    expect(autonomyCap(base, { runs: 5, firstTryPasses: 4 })).toBe(base * 2); // exactly 0.8
  });
  it("tightens the cap for a model that often ships a broken build (≤40%), with a floor", () => {
    expect(autonomyCap(base, { runs: 10, firstTryPasses: 2 })).toBe(Math.floor(base / 2));
    expect(autonomyCap(8, { runs: 10, firstTryPasses: 0 })).toBe(5); // floored at MIN_AUTONOMY_CAP
  });
  it("keeps the base cap in the middle band", () => {
    expect(autonomyCap(base, { runs: 10, firstTryPasses: 6 })).toBe(base); // 0.6
  });
});
