import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import {
  BACKOFF_CAP_S,
  MAX_ESCALATIONS,
  SAFE_MAX_OUTPUT_TOKENS,
  backoffSeconds,
  classify429,
  effectiveWindow,
  floorMaxTokens,
  isContextOverflowError,
  minOutputFloor,
  nextMaxTokens,
  parseOverflowMax,
  readySubstitute,
  shouldEscalate,
  synthesizeOverflow,
  updateLearnedCeiling,
} from "../src/index.js";

const model = (id: string, isReady?: boolean): CatalogModel => ({
  id,
  name: id,
  inputModalities: [],
  outputModalities: [],
  supportedFeatures: [],
  supportedSamplingParameters: [],
  isReady,
});

describe("output floors", () => {
  it("assumes reasoning when unknown", () => {
    expect(minOutputFloor({})).toBe(2048);
  });
  it("uses the non-reasoning floor when known non-reasoning", () => {
    expect(minOutputFloor({ reasoning: false })).toBe(256);
  });
  it("raises absent/too-small max_tokens to the floor, passes through larger", () => {
    expect(floorMaxTokens(undefined, { reasoning: true })).toBe(2048);
    expect(floorMaxTokens(100, { reasoning: false })).toBe(256);
    expect(floorMaxTokens(5000, { reasoning: true })).toBe(5000);
  });
  it("caps at the safety ceiling", () => {
    expect(floorMaxTokens(1_000_000, { reasoning: true })).toBe(SAFE_MAX_OUTPUT_TOKENS);
  });
  it("honors a measured-min override (e.g. Kimi)", () => {
    expect(floorMaxTokens(0, { reasoning: true, measuredMin: 256 })).toBe(256);
  });
});

describe("escalate-on-empty", () => {
  it("escalates only when empty AND truncated AND under the cap", () => {
    expect(shouldEscalate({ empty: true, truncated: true, escalations: 0 })).toBe(true);
    expect(shouldEscalate({ empty: true, truncated: false, escalations: 0 })).toBe(false);
    expect(shouldEscalate({ empty: false, truncated: true, escalations: 0 })).toBe(false);
    expect(shouldEscalate({ empty: true, truncated: true, escalations: MAX_ESCALATIONS })).toBe(
      false,
    );
  });
  it("doubles the budget with a floor, capped to window − prompt − 512", () => {
    expect(nextMaxTokens(256, { window: 100_000, promptTokens: 1000 })).toBe(2048);
    expect(nextMaxTokens(2048, { window: 100_000, promptTokens: 1000 })).toBe(4096);
    expect(nextMaxTokens(50_000, { window: 60_000, promptTokens: 1000 })).toBe(60_000 - 1000 - 512);
  });
});

describe("429 classification + backoff", () => {
  it("classifies cold vs rate_limit", () => {
    expect(classify429("no workers are currently available")).toBe("cold");
    expect(classify429("Rate limit exceeded, slow down")).toBe("rate_limit");
  });
  it("equal-jitter backoff grows and caps at 30s", () => {
    expect(backoffSeconds(0, () => 0)).toBe(1);
    expect(backoffSeconds(0, () => 1)).toBe(2);
    expect(backoffSeconds(3, () => 0)).toBe(8);
    expect(backoffSeconds(10, () => 0)).toBe(BACKOFF_CAP_S / 2);
  });
});

describe("ready/cold substitution", () => {
  const catalog = [
    model("moonshotai/kimi-k2.7-code", true),
    model("z-ai/glm-5.2", false),
    model("z-ai/glm-4.6", true),
    model("qwen/q", true),
  ];
  it("serves warm/unknown as-is (null)", () => {
    expect(readySubstitute("moonshotai/kimi-k2.7-code", catalog)).toBeNull();
    expect(readySubstitute("some/unknown-readiness", [model("some/unknown-readiness")])).toBeNull();
  });
  it("substitutes a vanished model", () => {
    expect(readySubstitute("gone/model", catalog)).not.toBeNull();
  });
  it("prefers the same vendor for a cold model", () => {
    expect(readySubstitute("z-ai/glm-5.2", catalog)).toBe("z-ai/glm-4.6");
  });
  it("falls back to default then any warm", () => {
    const c2 = [model("a/cold", false), model("b/warm", true)];
    expect(readySubstitute("a/cold", c2, { defaultModel: "b/warm" })).toBe("b/warm");
    expect(readySubstitute("a/cold", c2)).toBe("b/warm");
  });
  it("serves as-is when nothing is warm", () => {
    expect(readySubstitute("a/cold", [model("a/cold", false), model("b/cold", false)])).toBeNull();
  });
  it("prefers a lane-matched substitute, but falls back to any warm if none match", () => {
    const c = [
      model("a/cold", false),
      model("b/direct-warm", true),
      model("c/assisted-warm", true),
    ];
    // A direct request (native tools on the wire) must fail over to a direct-capable model.
    expect(readySubstitute("a/cold", c, { prefer: (id) => id === "b/direct-warm" })).toBe(
      "b/direct-warm",
    );
    // If NO warm model matches the lane, we still fail over (never stall) — to any warm model.
    expect(readySubstitute("a/cold", c, { prefer: () => false })).toBe("b/direct-warm");
  });
});

describe("overflow synthesis + detection", () => {
  it("emits the exact recognizable string", () => {
    expect(synthesizeOverflow(300_000, 262_144)).toBe(
      "prompt is too long: 300000 tokens > 262144 maximum",
    );
  });
  it("detects real overflow but not image/param 400s", () => {
    expect(isContextOverflowError("prompt is too long: 5 tokens > 4 maximum")).toBe(true);
    expect(isContextOverflowError("maximum context length exceeded")).toBe(true);
    expect(isContextOverflowError("invalid image payload", { hasImage: true })).toBe(false);
    expect(isContextOverflowError("unsupported parameter: temperature")).toBe(false);
  });
  it("an 'invalid request' wrapper around a REAL overflow is still an overflow", () => {
    expect(
      isContextOverflowError(
        "Invalid request: This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.",
      ),
    ).toBe(true);
    expect(isContextOverflowError('{"code":"context_length_exceeded"}')).toBe(true);
    expect(isContextOverflowError("input is longer than the model's context length")).toBe(true);
  });
  it("a real token overflow is detected even when the request carries images", () => {
    expect(
      isContextOverflowError("maximum context length is 32768 tokens, requested 50000", {
        hasImage: true,
      }),
    ).toBe(true);
    expect(isContextOverflowError("model does not support image input", { hasImage: true })).toBe(
      false,
    );
    expect(
      isContextOverflowError("image too large: exceeds maximum context", { hasImage: true }),
    ).toBe(false);
  });
  it("parseOverflowMax extracts the provider's real reported ceiling (the number after '>')", () => {
    expect(parseOverflowMax("prompt is too long: 300000 tokens > 262144 maximum")).toBe(262_144);
    expect(parseOverflowMax("requested 5000 tokens > 4096 max")).toBe(4096);
    expect(parseOverflowMax("no number here")).toBeUndefined();
  });
});

describe("learned ceiling (lower-only)", () => {
  it("effective window never exceeds a learned ceiling", () => {
    expect(effectiveWindow(262_144, 120_000)).toBe(120_000);
    expect(effectiveWindow(262_144, undefined)).toBe(262_144);
    expect(effectiveWindow(undefined, 120_000)).toBe(120_000);
  });
  it("a new learned ceiling only lowers", () => {
    expect(updateLearnedCeiling(120_000, 130_000)).toBe(120_000);
    expect(updateLearnedCeiling(120_000, 90_000)).toBe(90_000);
    expect(updateLearnedCeiling(undefined, 90_000)).toBe(90_000);
  });
});

describe("readySubstitute when the catalog flags every model cold", () => {
  const fleet = [model("a/one", false), model("b/two", false), model("c/three", false)];
  it("initial resolution serves the requested model as-is (the flag is a hint)", () => {
    expect(readySubstitute("a/one", fleet)).toBeNull();
  });
  it("failover (attemptCold) picks another flagged model instead of giving up", () => {
    const next = readySubstitute("a/one", fleet, {
      exclude: new Set(["a/one"]),
      attemptCold: true,
    });
    expect(next).not.toBeNull();
    expect(next).not.toBe("a/one");
  });
  it("never returns an excluded (already-failed) model", () => {
    const next = readySubstitute("a/one", fleet, {
      exclude: new Set(["a/one", "b/two"]),
      attemptCold: true,
    });
    expect(next).toBe("c/three");
    expect(
      readySubstitute("a/one", fleet, {
        exclude: new Set(["a/one", "b/two", "c/three"]),
        attemptCold: true,
      }),
    ).toBeNull();
  });
});
