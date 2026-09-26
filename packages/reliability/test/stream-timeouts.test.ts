import { describe, expect, it } from "vitest";
import { parseRetryAfter, streamTimeouts } from "../src/index.js";

describe("streamTimeouts", () => {
  it("scales the first-byte allowance with prompt size (a 1M prefill takes longer than a 1K one)", () => {
    const small = streamTimeouts({ promptTokens: 1_000 }, {});
    const huge = streamTimeouts({ promptTokens: 900_000 }, {});
    expect(huge.firstByteMs).toBeGreaterThan(small.firstByteMs);
    expect(huge.firstByteMs).toBeLessThanOrEqual(15 * 60_000);
  });
  it("gives deep reasoning more room than none", () => {
    const none = streamTimeouts({ promptTokens: 1_000, effort: "none" }, {});
    const max = streamTimeouts({ promptTokens: 1_000, effort: "max" }, {});
    expect(max.idleMs).toBeGreaterThan(none.idleMs);
    expect(max.firstByteMs).toBeGreaterThan(none.firstByteMs);
  });
  it("a flagged-cold model gets a short base leash but keeps the prefill allowance for big prompts", () => {
    const small = streamTimeouts({ promptTokens: 1_000, flaggedCold: true }, {});
    expect(small.firstByteMs).toBeLessThanOrEqual(31_000);
    const big = streamTimeouts({ promptTokens: 200_000, flaggedCold: true }, {});
    expect(big.firstByteMs).toBeGreaterThanOrEqual(150_000); // 200K prefill needs real time
    const bigReady = streamTimeouts({ promptTokens: 200_000 }, {});
    expect(big.firstByteMs).toBeLessThan(bigReady.firstByteMs);
  });
  it("honors env overrides", () => {
    const t = streamTimeouts(
      { promptTokens: 1 },
      { AMBIENT_FIRST_BYTE_TIMEOUT_MS: "5000", AMBIENT_STREAM_IDLE_TIMEOUT_MS: "7000" },
    );
    expect(t).toEqual({ firstByteMs: 5000, idleMs: 7000 });
  });
  it("ignores junk env values", () => {
    const t = streamTimeouts({ promptTokens: 1 }, { AMBIENT_STREAM_IDLE_TIMEOUT_MS: "banana" });
    expect(t.idleMs).toBeGreaterThan(0);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  it("parses delta-seconds", () => expect(parseRetryAfter("7", now)).toBe(7000));
  it("parses an HTTP date", () =>
    expect(parseRetryAfter("Fri, 25 Sep 2026 12:00:10 GMT", now)).toBe(10_000));
  it("returns undefined for missing/junk and clamps negatives to 0", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("Fri, 25 Sep 2026 11:59:00 GMT", now)).toBe(0);
  });
});
