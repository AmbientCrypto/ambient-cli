import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { summaryOutputTokens } from "../src/compaction-runner.js";

const model = (maxOutputLength: number): CatalogModel => ({
  id: "v/m",
  name: "m",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedFeatures: [],
  supportedSamplingParameters: [],
  contextLength: 200_000,
  maxOutputLength,
  isReady: true,
});

describe("summary output budget", () => {
  it("never asks for more than the model produces", () => {
    expect(summaryOutputTokens(model(256), 200_000)).toBe(256);
  });
  it("keeps its floor and its window share otherwise", () => {
    expect(summaryOutputTokens(model(8192), 4_000)).toBe(1024);
    expect(summaryOutputTokens(model(8192), 32_000)).toBe(4800);
  });
});
