import { describe, expect, it } from "vitest";
import { INLINE_GLOBE_CELLS, THINKING_GLOBE, makeGlobeFrames } from "../src/tui/globe.js";

describe("spinning globe", () => {
  it("THINKING_GLOBE is a set of equal-width single-row braille frames (inline)", () => {
    expect(THINKING_GLOBE.length).toBeGreaterThanOrEqual(8);
    for (const frame of THINKING_GLOBE) {
      expect(typeof frame).toBe("string");
      expect(frame.length).toBe(INLINE_GLOBE_CELLS); // one row, fixed cell width → no jitter in the layout
      for (const ch of frame) expect(ch.codePointAt(0)).toBeGreaterThanOrEqual(0x2800); // braille block
    }
  });

  it("rotates — consecutive frames differ (it actually spins, not a static blob)", () => {
    const distinct = new Set(THINKING_GLOBE);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("makeGlobeFrames honors the requested dimensions", () => {
    const g = makeGlobeFrames(6, 2, 10);
    expect(g).toHaveLength(10);
    expect(g[0]).toHaveLength(2); // rows
    expect(g[0]?.[0]?.length).toBe(6); // cols
  });
});
