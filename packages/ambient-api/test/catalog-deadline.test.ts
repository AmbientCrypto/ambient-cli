import { describe, expect, it } from "vitest";
import { type FetchLike, fetchCatalog } from "../src/index.js";

describe("fetching the model list", () => {
  it("gives up on a list that never finishes arriving", async () => {
    const trickle: FetchLike = async (_url, init) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('{"data":['));
          signal?.addEventListener("abort", () => ctrl.error(signal.reason));
        },
      });
      return new Response(body, { status: 200 });
    };
    const started = Date.now();
    await expect(
      fetchCatalog({ baseUrl: "https://api.ambient.xyz" }, { fetch: trickle, timeoutMs: 100 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
