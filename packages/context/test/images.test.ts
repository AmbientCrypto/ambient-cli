import { describe, expect, it } from "vitest";
import { HARD_MAX_IMAGES, estimateImageTokens, fitImages, planImages } from "../src/images.js";

describe("adaptive image planning", () => {
  it("a small window → low detail, 1 image; a big window → high detail, up to the hard max", () => {
    const small = planImages(8_000);
    expect(small.detail).toBe("low");
    expect(small.maxImages).toBe(1);
    expect(small.maxEdge).toBe(768);

    const big = planImages(262_144);
    expect(big.detail).toBe("high");
    expect(big.maxImages).toBe(HARD_MAX_IMAGES);
    expect(big.maxEdge).toBe(1568);
  });

  it("image token cost is bounded (tiles, conservative), never the base64 length", () => {
    const hi = estimateImageTokens(4000, 3000, "high", 1568); // huge screenshot, downscaled to 1568 edge
    expect(hi).toBeLessThanOrEqual(4290); // 130 base + at most 16 tiles * 260 (calibrated to real usage)
    expect(hi).toBeGreaterThan(1655); // …and NOT under the measured real cost of a mid-size image
    expect(estimateImageTokens(4000, 3000, "low", 768)).toBe(130); // low = flat thumbnail cost
  });

  it("fitImages keeps the NEWEST images that fit, and reports drops", () => {
    const imgs = ["a", "b", "c", "d", "e"]; // 5 images
    const plan = planImages(262_144);
    const fit = fitImages(imgs, 262_144, 1_000, plan);
    expect(fit.kept.length).toBeLessThanOrEqual(HARD_MAX_IMAGES);
    expect(fit.kept).toEqual(imgs.slice(imgs.length - fit.kept.length)); // newest kept
  });

  it("an image + a huge prompt degrades to low detail, then drops images if still tight", () => {
    const plan = planImages(262_144);
    // A prompt that eats almost the whole image budget → forces degrade/drop.
    const fit = fitImages(["only-one"], 40_000, 17_000, plan);
    // 40k*0.45=18k budget − 17k prompt = 1k left → high (2805) can't fit → degrade to low (85) → 1 fits.
    expect(fit.detail).toBe("low");
    expect(fit.kept.length).toBe(1);
  });

  it("no room at all → kept is empty (signals relay/skip)", () => {
    const plan = planImages(8_000);
    const fit = fitImages(["x"], 8_000, 5_000, plan); // 8k*0.45=3.6k − 5k = 0 budget
    expect(fit.kept).toEqual([]);
    expect(fit.dropped).toBe(1);
  });
});
