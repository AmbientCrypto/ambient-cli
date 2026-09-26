import { describe, expect, it } from "vitest";
import { type FetchLike, verifyApiKey } from "../src/index.js";

const cfg = { baseUrl: "https://api.ambient.xyz", apiKey: "k" };
const status =
  (code: number): FetchLike =>
  async () =>
    new Response("", { status: code });

describe("verifyApiKey (free check — no inference)", () => {
  it("401/403 → invalid", async () => {
    expect(await verifyApiKey(cfg, { fetch: status(401) })).toBe("invalid");
    expect(await verifyApiKey(cfg, { fetch: status(403) })).toBe("invalid");
  });
  it("an authenticated non-auth status (405 for GET on chat) → valid", async () => {
    expect(await verifyApiKey(cfg, { fetch: status(405) })).toBe("valid");
    expect(await verifyApiKey(cfg, { fetch: status(200) })).toBe("valid");
  });
  it("5xx, 404, 429 or a network failure → unknown (never a false 'signed in')", async () => {
    expect(await verifyApiKey(cfg, { fetch: status(502) })).toBe("unknown");
    expect(await verifyApiKey(cfg, { fetch: status(404) })).toBe("unknown");
    expect(await verifyApiKey(cfg, { fetch: status(429) })).toBe("unknown");
    const boom: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await verifyApiKey(cfg, { fetch: boom })).toBe("unknown");
  });
  it("uses GET (no request body → no model is run, nothing is billed)", async () => {
    let method = "";
    const spy: FetchLike = async (_u, init) => {
      method = init?.method ?? "";
      return new Response("", { status: 405 });
    };
    await verifyApiKey(cfg, { fetch: spy });
    expect(method).toBe("GET");
  });
});
