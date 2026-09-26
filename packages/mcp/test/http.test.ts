import { describe, expect, it } from "vitest";
import { type HttpFetch, spawnHttpTransport } from "../src/index.js";

const fakeFetch =
  (headers: Record<string, string>, body: string): HttpFetch =>
  async () => ({
    status: 200,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => body,
  });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("spawnHttpTransport", () => {
  it("POSTs a message and delivers a single JSON response to onMessage", async () => {
    const got: unknown[] = [];
    const { transport } = spawnHttpTransport(
      { url: "https://x/mcp" },
      fakeFetch(
        { "content-type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
      ),
    );
    transport.onMessage((m) => got.push(m));
    transport.send('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await tick();
    expect(got).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("parses an SSE (text/event-stream) response into messages", async () => {
    const got: unknown[] = [];
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"a":1}}\n\n';
    const { transport } = spawnHttpTransport(
      { url: "https://x" },
      fakeFetch({ "content-type": "text/event-stream" }, sse),
    );
    transport.onMessage((m) => got.push(m));
    transport.send('{"id":2}\n');
    await tick();
    expect(got).toEqual([{ jsonrpc: "2.0", id: 2, result: { a: 1 } }]);
  });

  it("does not deliver anything after close()", async () => {
    const got: unknown[] = [];
    const { transport } = spawnHttpTransport(
      { url: "https://x" },
      fakeFetch({ "content-type": "application/json" }, '{"id":3}'),
    );
    transport.onMessage((m) => got.push(m));
    transport.close();
    transport.send('{"id":3}\n');
    await tick();
    expect(got).toEqual([]); // a closed transport sends nothing
  });
});
