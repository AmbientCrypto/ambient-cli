import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { pickBestModel } from "../src/pick-best.js";

function m(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools", "reasoning"],
    supportedSamplingParameters: [],
    contextLength: 128_000,
    isReady: true,
    ...over,
  };
}

// A realistic slice of the live fleet (shapes as of 2026-09) — the heuristic must adapt to ANY catalog.
const FLEET: CatalogModel[] = [
  m("z-ai/glm-5.2", { contextLength: 202_752, isReady: true }),
  m("google/gemma-4-26b-a4b-it", { contextLength: 262_144, isReady: false }),
  m("moonshotai/kimi-k2.7-code", { contextLength: 262_144, isReady: true }),
  m("deepseek/deepseek-v4-flash-0731", { contextLength: 1_048_576, isReady: true }),
  m("ambient/large", { contextLength: 202_752, isReady: true }),
  m("ambient/small", { contextLength: 262_144, isReady: false }),
];

describe("pickBestModel", () => {
  it("returns undefined for an empty catalog (never throws)", () => {
    expect(pickBestModel([])).toBeUndefined();
  });

  it("ranks by declared capabilities: reasoning + a bigger window beat a small non-reasoning model", () => {
    const fleet = [
      m("x/small", { contextLength: 32_768, supportedFeatures: ["tools"] }),
      m("y/big-reasoner", { contextLength: 202_752, supportedFeatures: ["tools", "reasoning"] }),
    ];
    expect(pickBestModel(fleet)).toBe("y/big-reasoner");
  });

  it("a new 1M-context model is preferred automatically — no code change", () => {
    const withNew = [
      ...FLEET,
      m("newco/brand-new", { contextLength: 1_048_576, maxOutputLength: 65_536 }),
    ];
    expect(["newco/brand-new", "deepseek/deepseek-v4-flash-0731"]).toContain(
      pickBestModel(withNew),
    );
  });

  it("only ever returns a READY model when any ready model exists", () => {
    // Make two models cold; the most capable READY one must win over any cold model.
    const cat = FLEET.map((x) =>
      x.id === "moonshotai/kimi-k2.7-code" || x.id === "ambient/large"
        ? { ...x, isReady: false }
        : x,
    );
    const pick = pickBestModel(cat);
    expect(cat.find((x) => x.id === pick)?.isReady).toBe(true);
    expect(pick).toBe("deepseek/deepseek-v4-flash-0731"); // the most capable READY model (1M window)
  });

  it("falls back to a COLD model when nothing is ready (cold-start still resolves)", () => {
    const allCold = FLEET.map((x) => ({ ...x, isReady: false }));
    expect(pickBestModel(allCold)).toBe("deepseek/deepseek-v4-flash-0731"); // most capable, even though cold
  });

  it("prefers a tool-capable model (a coding agent needs native tool-calls)", () => {
    const cat = [
      m("vendor/no-tools-huge", { contextLength: 2_000_000, supportedFeatures: ["reasoning"] }),
      m("vendor/tools-small", { contextLength: 32_768, supportedFeatures: ["tools", "reasoning"] }),
    ];
    expect(pickBestModel(cat)).toBe("vendor/tools-small");
  });

  it("never interprets model names: 'code'/'flash'/'large' in an id changes nothing", () => {
    const same = { contextLength: 131_072, maxOutputLength: 8_192 };
    const fleet = [m("z/super-code-large", same), m("a/plain", same), m("m/tiny-flash", same)];
    expect(pickBestModel(fleet)).toBe("a/plain"); // an exact capability tie → deterministic id order
  });

  it("is deterministic on a tie (stable id order)", () => {
    const a = m("vendor/alpha", { supportedFeatures: ["tools"] });
    const b = m("vendor/beta", { supportedFeatures: ["tools"] });
    expect(pickBestModel([a, b])).toBe(pickBestModel([b, a]));
  });
});

describe("learned outcomes steer the default", () => {
  it("between comparable models, one that keeps failing loses to one that works", () => {
    const same = { contextLength: 131_072, maxOutputLength: 8_192 };
    const fleet = [m("a/one", same), m("b/two", same)];
    const stats = (id: string) =>
      id === "a/one"
        ? { okRate: 0.2, latencyMs: 20_000, samples: 10 }
        : { okRate: 0.95, latencyMs: 4_000, samples: 10 };
    expect(pickBestModel(fleet)).toBe("a/one"); // no evidence → deterministic id order
    expect(pickBestModel(fleet, stats)).toBe("b/two"); // evidence flips it
  });
  it("a couple of samples are not enough evidence to move the ranking", () => {
    const same = { contextLength: 131_072 };
    const fleet = [m("a/one", same), m("b/two", same)];
    expect(
      pickBestModel(fleet, (id) => (id === "a/one" ? { okRate: 0, samples: 2 } : undefined)),
    ).toBe("a/one");
  });
});
