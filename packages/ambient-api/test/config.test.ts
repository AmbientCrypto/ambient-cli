import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  catalogUrl,
  chatUrl,
  normalizeBaseUrl,
  resolveConfig,
} from "../src/index.js";

describe("normalizeBaseUrl", () => {
  it("accepts https ambient.xyz + subdomains and strips path", () => {
    expect(normalizeBaseUrl("https://api.ambient.xyz")).toBe("https://api.ambient.xyz");
    expect(normalizeBaseUrl("https://api.ambient.xyz/v1/")).toBe("https://api.ambient.xyz");
    expect(normalizeBaseUrl("https://ambient.xyz")).toBe("https://ambient.xyz");
  });
  it("rejects http, other hosts, and suffix-spoofing", () => {
    expect(() => normalizeBaseUrl("http://api.ambient.xyz")).toThrow();
    expect(() => normalizeBaseUrl("https://evil.example.com")).toThrow();
    expect(() => normalizeBaseUrl("https://api.ambient.xyz.evil.com")).toThrow();
  });
  it("allows loopback only with allowInsecure", () => {
    expect(() => normalizeBaseUrl("http://127.0.0.1:8080")).toThrow();
    expect(normalizeBaseUrl("http://127.0.0.1:8080", { allowInsecure: true })).toBe(
      "http://127.0.0.1:8080",
    );
  });
});

describe("resolveConfig", () => {
  it("defaults to the Ambient base and reads the key", () => {
    const c = resolveConfig({ AMBIENT_API_KEY: "ambient-key-abc123" });
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(c.apiKey).toBe("ambient-key-abc123");
  });
  it("honors AMBIENT_API_URL override", () => {
    expect(resolveConfig({ AMBIENT_API_URL: "https://api.ambient.xyz" }).baseUrl).toBe(
      "https://api.ambient.xyz",
    );
  });
  it("builds endpoint urls", () => {
    const c = { baseUrl: "https://api.ambient.xyz" };
    expect(catalogUrl(c)).toBe("https://api.ambient.xyz/v1/models");
    expect(chatUrl(c)).toBe("https://api.ambient.xyz/v1/chat/completions");
  });
});
