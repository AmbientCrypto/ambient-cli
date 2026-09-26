import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { pickForRole } from "../src/pick-best.js";

function m(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 200_000,
    isReady: true,
    ...over,
  };
}

// A representative live fleet: a coding flagship, a reasoning flagship, and a cheap flash model.
// A representative fleet described ONLY by catalog capabilities (names are never interpreted).
const fleet: CatalogModel[] = [
  m("a/big", { contextLength: 262_144, maxOutputLength: 65_536 }), // biggest, no reasoning
  m("b/reasoner", { contextLength: 131_072, supportedFeatures: ["tools", "reasoning"] }), // reasoning
  m("c/small", { contextLength: 32_768, maxOutputLength: 4_096 }), // smallest
];

describe("pickForRole", () => {
  it("executor takes the most capable model by declared capabilities", () => {
    expect(pickForRole("executor", fleet)).toBe("b/reasoner"); // reasoning outweighs a 2× window
  });

  it("planner and reviewer prefer the reasoning model", () => {
    expect(pickForRole("planner", fleet)).toBe("b/reasoner");
    expect(pickForRole("reviewer", fleet)).toBe("b/reasoner");
  });

  it("compactor (no pricing) prefers the smallest model — don't spend the biggest one on summarization", () => {
    expect(pickForRole("compactor", fleet)).toBe("c/small");
  });

  it("compactor ranks by PRICING when the catalog has it (a cheap generic beats an expensive `flash`)", () => {
    const priced = [
      m("vendor/expensive-flash", { pricing: { input: 5, output: 15 } }), // named flash but pricey
      m("vendor/cheap-generic", { pricing: { input: 0.1, output: 0.2 } }), // genuinely cheap
    ];
    expect(pickForRole("compactor", priced)).toBe("vendor/cheap-generic");
  });

  it("reviewer avoids the executor's model when a comparable warm peer exists (second opinion)", () => {
    // Two reasoning flagships: reviewer should NOT return the one we're avoiding.
    const two = [
      m("a/reasoner-large", { supportedFeatures: ["tools", "reasoning"] }),
      m("b/reasoner-max", { supportedFeatures: ["tools", "reasoning"] }),
    ];
    const first = pickForRole("reviewer", two);
    const second = pickForRole("reviewer", two, { avoid: first });
    expect(second).not.toBe(first);
  });

  it("falls back rather than returning undefined when only one model exists", () => {
    const one = [m("solo/only", { supportedFeatures: ["tools", "reasoning"] })];
    expect(pickForRole("reviewer", one, { avoid: "solo/only" })).toBe("solo/only");
  });

  it("returns undefined for an empty fleet; still resolves when all are cold", () => {
    expect(pickForRole("executor", [])).toBeUndefined();
    const cold = fleet.map((x) => ({ ...x, isReady: false }));
    expect(pickForRole("executor", cold)).toBeDefined();
  });

  it("compactor does not require tool support (a text-only model can summarize)", () => {
    const noTools = [
      m("cheap/flash-text", { supportedFeatures: [] }),
      m("coder/kimi-code", { supportedFeatures: ["tools"] }),
    ];
    expect(pickForRole("compactor", noTools)).toBe("cheap/flash-text");
  });
});
