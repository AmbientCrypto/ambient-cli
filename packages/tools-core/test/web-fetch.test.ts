import type { ToolContext } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { makeWebFetchTool } from "../src/index.js";

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/tmp",
  workspaceRoot: "/tmp",
  signal: signal ?? new AbortController().signal,
  secret: async () => "",
  emit: () => {},
});

// A minimal stubbed fetch Response with a fixed body.
function res(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}) {
  const h = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const bytes =
    typeof opts.body === "string"
      ? new TextEncoder().encode(opts.body)
      : (opts.body ?? new Uint8Array());
  return {
    status: opts.status ?? 200,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return ab;
    },
  };
}

const publicLookup = async () => [{ address: "1.1.1.1" }];

describe("web_fetch tool", () => {
  it("fetches HTML and returns readable text + title", async () => {
    const tool = makeWebFetchTool({
      lookup: publicLookup,
      fetchImpl: async () =>
        res({
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<html><head><title>Doc</title></head><body><script>bad()</script><p>Hello world</p></body></html>",
        }),
    });
    const out = await tool.execute({ url: "https://example.com/doc" }, ctx());
    expect(out.status).toBe(200);
    expect(out.title).toBe("Doc");
    expect(out.text).toContain("Hello world");
    expect(out.text).not.toContain("bad()");
    expect(out.finalUrl).toBe("https://example.com/doc");
  });

  it("PINS the guard-vetted IP into the connection (closes the DNS-rebind window)", async () => {
    let pinnedAddrs: { address: string }[] | undefined;
    let fetchGotThePinnedDispatcher = false;
    const marker = { close: async () => {} };
    const tool = makeWebFetchTool({
      lookup: async () => [{ address: "1.1.1.1" }], // the address the SSRF guard vets
      makeDispatcher: (addrs) => {
        pinnedAddrs = addrs;
        return marker;
      },
      fetchImpl: async (_url, init) => {
        fetchGotThePinnedDispatcher = (init as { dispatcher?: unknown }).dispatcher === marker;
        return res({ headers: { "content-type": "text/plain" }, body: "ok" });
      },
    });
    await tool.execute({ url: "https://example.com" }, ctx());
    expect(pinnedAddrs).toEqual([{ address: "1.1.1.1" }]); // the dispatcher pins the VETTED addr…
    expect(fetchGotThePinnedDispatcher).toBe(true); // …and fetch connects through it (no independent re-resolve)
  });

  it("refuses a blocked scheme before any fetch", async () => {
    let called = false;
    const tool = makeWebFetchTool({
      lookup: publicLookup,
      fetchImpl: async () => {
        called = true;
        return res({});
      },
    });
    await expect(tool.execute({ url: "file:///etc/passwd" }, ctx())).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("refuses a host that resolves to an internal address (SSRF)", async () => {
    const tool = makeWebFetchTool({
      lookup: async () => [{ address: "169.254.169.254" }],
      fetchImpl: async () => res({ body: "secret" }),
    });
    await expect(tool.execute({ url: "https://metadata.evil.test/" }, ctx())).rejects.toThrow(
      /blocked address/,
    );
  });

  it("re-validates redirect targets — a redirect to an internal host is refused", async () => {
    // First hop: public host 302 → http://127.0.0.1/. The lookup for the SECOND host is internal.
    const tool = makeWebFetchTool({
      lookup: async (host: string) =>
        host === "start.test" ? [{ address: "1.1.1.1" }] : [{ address: "10.0.0.1" }],
      fetchImpl: async (url: string) => {
        if (url.includes("start.test"))
          return res({ status: 302, headers: { location: "http://intranet.test/secret" } });
        return res({ body: "SHOULD NOT REACH" });
      },
    });
    await expect(tool.execute({ url: "https://start.test/" }, ctx())).rejects.toThrow(
      /blocked address/,
    );
  });

  it("cancels the redirect response body before following (no leaked connection)", async () => {
    let redirectBodyCancelled = false;
    const tool = makeWebFetchTool({
      lookup: publicLookup,
      fetchImpl: async (url: string) => {
        if (url === "https://a.test/") {
          return {
            status: 302,
            headers: {
              get: (n: string) => (n.toLowerCase() === "location" ? "https://b.test/x" : null),
            },
            body: {
              getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
              cancel: async () => {
                redirectBodyCancelled = true;
              },
            },
            async arrayBuffer() {
              return new ArrayBuffer(0);
            },
          };
        }
        return res({ headers: { "content-type": "text/plain" }, body: "ok" });
      },
    });
    await tool.execute({ url: "https://a.test/" }, ctx());
    expect(redirectBodyCancelled).toBe(true);
  });

  it("follows a redirect to another public host and reports the final url", async () => {
    const tool = makeWebFetchTool({
      lookup: publicLookup,
      fetchImpl: async (url: string) => {
        if (url === "https://a.test/")
          return res({ status: 301, headers: { location: "https://b.test/final" } });
        return res({ headers: { "content-type": "text/plain" }, body: "landed" });
      },
    });
    const out = await tool.execute({ url: "https://a.test/" }, ctx());
    expect(out.finalUrl).toBe("https://b.test/final");
    expect(out.text).toBe("landed");
  });

  it("caps the body at maxBytes and marks truncated", async () => {
    const big = "x".repeat(5000);
    const tool = makeWebFetchTool({
      lookup: publicLookup,
      fetchImpl: async () => res({ headers: { "content-type": "text/plain" }, body: big }),
    });
    const out = await tool.execute({ url: "https://example.com", maxBytes: 1000 }, ctx());
    expect(out.truncated).toBe(true);
    expect(out.bytesFetched).toBe(1000);
    expect(out.text.length).toBe(1000);
  });

  it("stops early when the caller's signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const tool = makeWebFetchTool({
      lookup: publicLookup,
      fetchImpl: async (_url: string, init: Record<string, unknown>) => {
        const sig = init.signal as AbortSignal;
        if (sig.aborted) throw new Error("aborted");
        return res({ body: "x" });
      },
    });
    await expect(tool.execute({ url: "https://example.com" }, ctx(ac.signal))).rejects.toThrow(
      /aborted/,
    );
  });

  it("streams via a ReadableStream body and stops at the cap", async () => {
    // A body that yields 3 chunks of 400 bytes; cap 1000 → truncated after ~1000 bytes, reader cancelled.
    let cancelled = false;
    const chunk = new Uint8Array(400).fill(97);
    let n = 0;
    const streamRes = {
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "text/plain" : null),
      },
      body: {
        getReader() {
          return {
            async read() {
              if (n++ < 3) return { done: false, value: chunk };
              return { done: true, value: undefined };
            },
            async cancel() {
              cancelled = true;
            },
          };
        },
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    };
    const tool = makeWebFetchTool({ lookup: publicLookup, fetchImpl: async () => streamRes });
    const out = await tool.execute({ url: "https://example.com", maxBytes: 1000 }, ctx());
    expect(out.bytesFetched).toBe(1000);
    expect(out.truncated).toBe(true);
    expect(cancelled).toBe(true);
  });
});
