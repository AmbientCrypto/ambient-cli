import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { AUTO_MODEL, resolveRequestedModel } from "../src/resolve-model.js";

function m(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools", "reasoning"],
    supportedSamplingParameters: [],
    contextLength: 200_000,
    isReady: true,
    ...over,
  };
}

const catalog: CatalogModel[] = [
  m("moonshotai/kimi-k2.7-code", { isReady: true }),
  m("z-ai/glm-5.2", { isReady: true }),
  m("acme/legacy", { isReady: false }),
];

describe("resolveRequestedModel — one shared source of truth", () => {
  it("honors a concrete ready model exactly", () => {
    expect(resolveRequestedModel("z-ai/glm-5.2", catalog)).toEqual({
      requested: "z-ai/glm-5.2",
      target: "z-ai/glm-5.2",
      rule: "exact-live",
    });
  });

  it("substitutes a warm model when the requested one is cold, with a reason", () => {
    const res = resolveRequestedModel("acme/legacy", catalog);
    expect(res?.rule).toBe("ready-substitution");
    expect(res?.requested).toBe("acme/legacy");
    expect(res?.target).not.toBe("acme/legacy");
    expect(catalog.find((x) => x.id === res?.target)?.isReady).toBe(true);
    expect(res?.reason).toMatch(/cold/);
  });

  it("resolves the `auto` sentinel AND an omitted value to the best live pick", () => {
    for (const requested of [AUTO_MODEL, undefined]) {
      const res = resolveRequestedModel(requested, catalog);
      expect(res?.rule).toBe("auto-best");
      expect(res?.requested).toBe(AUTO_MODEL);
      expect(res?.target).toBe("moonshotai/kimi-k2.7-code"); // coding-specialized ready model
    }
  });

  it("distinguishes an UNKNOWN model id (a typo) from a known-but-cold one", () => {
    const res = resolveRequestedModel("typo/does-not-exist", catalog);
    expect(res?.rule).toBe("unknown-substitution"); // NOT "ready-substitution" — it isn't cold, it's a typo
    expect(res?.requested).toBe("typo/does-not-exist");
    expect(catalog.find((x) => x.id === res?.target)?.isReady).toBe(true);
    expect(res?.reason).not.toMatch(/cold/i); // must NOT claim the (nonexistent) model is "cold"
    expect(res?.reason).toMatch(/no model/i);
  });

  it("returns null for an empty fleet for ANY input (never a dead target)", () => {
    expect(resolveRequestedModel(AUTO_MODEL, [])).toBeNull();
    expect(resolveRequestedModel(undefined, [])).toBeNull();
    expect(resolveRequestedModel("vendor/model", [])).toBeNull(); // concrete id too — not exact-live
  });

  it("auto substitutes a COLD best-pick to a warm peer (parity with explicit ready-substitution)", () => {
    // The coding-specialized model is the best pick but COLD; a warm peer exists → serve the warm one.
    const cat = [
      m("moonshotai/kimi-k2.7-code", { isReady: false }),
      m("z-ai/glm-5.2", { isReady: true }),
    ];
    const res = resolveRequestedModel(AUTO_MODEL, cat);
    expect(res?.rule).toBe("auto-best");
    expect(res?.target).toBe("z-ai/glm-5.2"); // warm, not the cold best
    expect(cat.find((x) => x.id === res?.target)?.isReady).toBe(true);
  });
});
