import { describe, expect, it } from "vitest";
import { AmbientChatClient } from "../src/agent/ambient-client.js";

const body = (ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, context_length: 32_768 })),
});

describe("catalog cache", () => {
  it("reuses the catalog briefly, but a fresh request always hits the network", async () => {
    let fetches = 0;
    const fake = async () => {
      fetches += 1;
      return new Response(JSON.stringify(body([`m/${fetches}`])), { status: 200 });
    };
    const c = new AmbientChatClient(
      { baseUrl: "https://api.ambient.xyz" },
      { fetch: fake as never, ttlMs: 60_000 },
    );
    const a = await c.fetchCatalog();
    const b = await c.fetchCatalog();
    expect(fetches).toBe(1);
    expect(b).toBe(a);
    const fresh = await c.fetchCatalog(undefined, { fresh: true });
    expect(fetches).toBe(2);
    expect(fresh[0]?.id).toBe("m/2");
  });
  it("falls back to the last good catalog if a refresh fails", async () => {
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n > 1) throw new Error("network down");
      return new Response(JSON.stringify(body(["m/a"])), { status: 200 });
    };
    const c = new AmbientChatClient(
      { baseUrl: "https://api.ambient.xyz" },
      { fetch: flaky as never, ttlMs: 0 },
    );
    await c.fetchCatalog();
    const again = await c.fetchCatalog();
    expect(again[0]?.id).toBe("m/a");
  });
});
