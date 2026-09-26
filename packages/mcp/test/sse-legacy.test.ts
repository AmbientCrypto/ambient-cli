import { describe, expect, it } from "vitest";
import { JsonRpcClient } from "../src/jsonrpc.js";
import { type SseFetch, SseParser, spawnSseTransport } from "../src/sse-legacy.js";

const settle = () => new Promise((r) => setTimeout(r, 20));

/** A fake server: an event stream we can write to, and a record of POSTs. */
function fakeServer(endpointEvent: string) {
  const posts: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let push: (s: string) => void = () => {};
  let streamHeaders: Record<string, string> = {};
  const fetchImpl: SseFetch = async (url, init) => {
    if (init.method === "GET") {
      streamHeaders = init.headers as Record<string, string>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          push = (s) => controller.enqueue(enc.encode(s));
          push(endpointEvent);
        },
      });
      return { ok: true, status: 200, body };
    }
    const body = String(init.body);
    posts.push({ url, body, headers: init.headers as Record<string, string> });
    const msg = JSON.parse(body) as { id?: number };
    if (msg.id !== undefined) {
      push(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: msg.id } })}\n\n`,
      );
    }
    return { ok: true, status: 202 };
  };
  return { fetchImpl, posts, headers: () => streamHeaders };
}

describe("SSE parsing", () => {
  it("joins data lines, names events, skips comments, and handles split chunks", () => {
    const got: Array<[string, string]> = [];
    const p = new SseParser((e, d) => got.push([e, d]));
    p.push(": keep-alive\n\nevent: endpoint\ndata: /msg?s=1\n");
    p.push('\ndata: {"a":\ndata: 1}\r\n\r\n');
    expect(got).toEqual([
      ["endpoint", "/msg?s=1"],
      ["message", '{"a":\n1}'],
    ]);
  });
});

describe("legacy SSE transport", () => {
  it("waits for the endpoint, posts there with the headers, and reads replies off the stream", async () => {
    const srv = fakeServer("event: endpoint\ndata: /messages?sessionId=abc\n\n");
    const { transport } = spawnSseTransport(
      { url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer t" } },
      srv.fetchImpl,
    );
    const rpc = new JsonRpcClient(transport, { requestTimeoutMs: 2000 });
    const result = await rpc.request("tools/list", {});
    expect(result).toEqual({ ok: 1 });
    expect(srv.posts[0]?.url).toBe("https://mcp.example.com/messages?sessionId=abc");
    expect(srv.posts[0]?.headers.Authorization).toBe("Bearer t");
    expect(srv.headers().accept).toBe("text/event-stream");
    rpc.close();
  });

  it("refuses an endpoint on another origin (auth headers never leave the server's origin)", async () => {
    const srv = fakeServer("event: endpoint\ndata: https://evil.example/collect\n\n");
    const { transport } = spawnSseTransport(
      { url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer t" } },
      srv.fetchImpl,
    );
    const rpc = new JsonRpcClient(transport, { requestTimeoutMs: 2000 });
    await expect(rpc.request("tools/list", {})).rejects.toThrow(/another origin/);
    await settle();
    expect(srv.posts).toEqual([]);
  });
});
