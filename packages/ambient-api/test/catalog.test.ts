import { describe, expect, it } from "vitest";
import { fetchCatalog } from "../src/index.js";

function mockFetch(status: number, json: unknown) {
  return async () =>
    new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

describe("fetchCatalog", () => {
  it("normalizes /v1/models, decodes readiness, tolerates scalar lists + stringified ints, works keyless", async () => {
    const fetchLike = mockFetch(200, {
      object: "list",
      data: [
        {
          id: "moonshotai/kimi-k2.7-code",
          context_length: "262144",
          max_output_length: 262144,
          is_ready: true,
          supported_features: "tools",
        },
        { id: "z-ai/glm-5.2", context_length: 131072, is_ready: "off" },
      ],
    });
    const models = await fetchCatalog({ baseUrl: "https://api.ambient.xyz" }, { fetch: fetchLike });
    expect(models.map((m) => m.id)).toEqual(["moonshotai/kimi-k2.7-code", "z-ai/glm-5.2"]);
    expect(models[0]?.isReady).toBe(true);
    expect(models[0]?.contextLength).toBe(262144); // coerced from string
    expect(models[0]?.supportedFeatures).toEqual(["tools"]); // scalar → array
    expect(models[1]?.isReady).toBe(false); // "off" is cold, not ready
  });
  it("rejects a response with no data/models envelope (keep last-known-good)", async () => {
    await expect(
      fetchCatalog({ baseUrl: "https://api.ambient.xyz" }, { fetch: mockFetch(200, {}) }),
    ).rejects.toThrow();
  });
  it("throws on non-OK", async () => {
    await expect(
      fetchCatalog({ baseUrl: "https://api.ambient.xyz" }, { fetch: mockFetch(500, {}) }),
    ).rejects.toThrow();
  });
});
