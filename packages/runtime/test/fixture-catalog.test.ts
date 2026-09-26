import { supportsVision } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import {
  TEXT_1M,
  TEXT_200K,
  VISION_32K,
  catalogOf,
  cold,
  noReasoning,
  noTools,
} from "./fixtures/catalog.js";

describe("fixture catalog harness", () => {
  it("parses the three window sizes through the production normalizer", () => {
    const [v, t, m] = catalogOf(VISION_32K, TEXT_200K, TEXT_1M);
    expect(v?.contextLength).toBe(32_768);
    expect(v && supportsVision(v)).toBe(true);
    expect(t?.contextLength).toBe(202_752);
    expect(t && supportsVision(t)).toBe(false);
    expect(m?.contextLength).toBe(1_048_576);
    expect(m?.maxOutputLength).toBe(65_536);
  });

  it("variants strip capabilities and flip readiness", () => {
    const [a, b, c] = catalogOf(noTools(TEXT_200K), noReasoning(TEXT_1M), cold(VISION_32K));
    expect(a?.supportedFeatures).not.toContain("tools");
    expect(b?.supportedFeatures).not.toContain("reasoning");
    expect(c?.isReady).toBe(false);
  });
});
