import { describe, expect, it } from "vitest";
import { isParseError, parseEffort, parseMaxTurns } from "../src/commands/args.js";

describe("parseEffort", () => {
  it("accepts every known level (case-insensitive) and rejects the rest", () => {
    for (const v of ["auto", "off", "low", "medium", "high", "HIGH", "Auto"]) {
      expect(isParseError(parseEffort(v))).toBe(false);
    }
    expect(isParseError(parseEffort("bogus"))).toBe(true);
    expect(isParseError(parseEffort(undefined))).toBe(true);
  });
});

describe("parseMaxTurns", () => {
  it("accepts integers in [1,1000] and rejects missing / non-integer / out-of-range", () => {
    expect(parseMaxTurns("1")).toBe(1);
    expect(parseMaxTurns("1000")).toBe(1000);
    for (const bad of [undefined, "0", "-3", "1001", "3.5", "abc", ""]) {
      expect(isParseError(parseMaxTurns(bad))).toBe(true);
    }
  });
});
