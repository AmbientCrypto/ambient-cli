import { describe, expect, it } from "vitest";
import {
  CatalogResponseSchema,
  RawCatalogModelSchema,
  decodeReadiness,
  normalizeCatalog,
  normalizeCatalogModel,
} from "../src/index.js";

describe("decodeReadiness", () => {
  it("decodes stringly-typed falsy values to false (incl. off/cold)", () => {
    for (const v of ["false", "0", "no", "FALSE", " No ", "off", "cold"]) {
      expect(decodeReadiness(v)).toBe(false);
    }
  });
  it("decodes truthy values to true", () => {
    expect(decodeReadiness(true)).toBe(true);
    expect(decodeReadiness("true")).toBe(true);
    expect(decodeReadiness(1)).toBe(true);
    expect(decodeReadiness("ready")).toBe(true);
  });
  it("treats missing/empty/unknown tokens as unknown (undefined) — never optimistically ready", () => {
    expect(decodeReadiness(undefined)).toBeUndefined();
    expect(decodeReadiness(null)).toBeUndefined();
    expect(decodeReadiness("")).toBeUndefined();
    expect(decodeReadiness("garbage")).toBeUndefined();
    expect(decodeReadiness("maybe")).toBeUndefined();
  });
});

describe("normalizeCatalogModel", () => {
  it("maps snake_case wire fields to camelCase and defaults name to id", () => {
    const raw = RawCatalogModelSchema.parse({
      id: "moonshotai/kimi-k2.7-code",
      context_length: 262144,
      max_output_length: 262144,
      is_ready: "true",
      supported_features: ["tools"],
    });
    const m = normalizeCatalogModel(raw);
    expect(m.id).toBe("moonshotai/kimi-k2.7-code");
    expect(m.name).toBe("moonshotai/kimi-k2.7-code");
    expect(m.contextLength).toBe(262144);
    expect(m.maxOutputLength).toBe(262144);
    expect(m.isReady).toBe(true);
    expect(m.supportedFeatures).toEqual(["tools"]);
  });
});

describe("normalizeCatalog", () => {
  it("reads either { data } or { models } and normalizes every row", () => {
    const res = CatalogResponseSchema.parse({
      models: [
        { id: "z-ai/glm-5.2", is_ready: false },
        { id: "moonshotai/kimi-k2.7-code", is_ready: true },
      ],
    });
    const list = normalizeCatalog(res);
    expect(list.map((m) => m.id)).toEqual(["z-ai/glm-5.2", "moonshotai/kimi-k2.7-code"]);
    expect(list[0]?.isReady).toBe(false);
    expect(list[1]?.isReady).toBe(true);
  });
});

describe("forward compatibility", () => {
  it("one malformed model row is skipped — it never breaks the whole catalog", async () => {
    const { CatalogResponseSchema, normalizeCatalog } = await import("../src/index.js");
    const res = CatalogResponseSchema.parse({
      object: "list",
      data: [
        { id: "good/one", context_length: 32768 },
        { name: "no id at all" },
        { id: "", context_length: 1 },
        {
          id: "good/two",
          context_length: "1048576",
          supported_features: ["tools", "future_feature"],
        },
      ],
    });
    const models = normalizeCatalog(res);
    expect(models.map((m) => m.id)).toEqual(["good/one", "good/two"]);
    expect(models[1]?.contextLength).toBe(1_048_576);
    expect(models[1]?.supportedFeatures).toContain("future_feature");
  });
  it("unknown new fields and modalities pass through parsing without error", async () => {
    const { CatalogResponseSchema, normalizeCatalog } = await import("../src/index.js");
    const models = normalizeCatalog(
      CatalogResponseSchema.parse({
        data: [
          { id: "v/omni", input_modalities: ["text", "image", "video"], brand_new_field: { x: 1 } },
        ],
      }),
    );
    expect(models[0]?.inputModalities).toEqual(["text", "image", "video"]);
  });
});

describe("catalog entries with null fields", () => {
  it("keeps the model and reads null text fields as absent", () => {
    const models = normalizeCatalog(
      CatalogResponseSchema.parse({
        data: [
          { id: "ok/x", name: "X" },
          { id: "nulls/y", name: null, description: null, hugging_face_id: null, is_ready: null },
        ],
      }),
    );
    const y = models.find((m) => m.id === "nulls/y");
    expect(y).toBeDefined();
    expect(y?.name).toBe("nulls/y");
    expect(y?.description).toBeUndefined();
    expect(y?.isReady).toBeUndefined();
  });
});
