import type { ToolContext } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import {
  makeWebSearchTool,
  parseDdgHtml,
  parseSearxng,
  resolveProvider,
} from "../src/tools/web-search.js";

describe("web_search parsers", () => {
  it("parseSearxng maps {results:[{title,url,content}]} and bounds; malformed → []", () => {
    const body = JSON.stringify({
      results: [
        {
          title: "Zod docs",
          url: "https://zod.dev",
          content: "TypeScript-first schema validation",
        },
        { url: "https://example.com" }, // title falls back to url; snippet empty
      ],
    });
    const r = parseSearxng(body);
    expect(r[0]).toEqual({
      title: "Zod docs",
      url: "https://zod.dev",
      snippet: "TypeScript-first schema validation",
    });
    expect(r[1]?.title).toBe("https://example.com");
    expect(parseSearxng("not json")).toEqual([]);
  });

  it("parseDdgHtml unwraps the /l/?uddg= redirect and strips tags", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&rut=x">Example <b>Doc</b></a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">A helpful <b>snippet</b> here</a>`;
    const r = parseDdgHtml(html);
    expect(r).toHaveLength(1);
    expect(r[0]?.url).toBe("https://example.com/doc");
    expect(r[0]?.title).toBe("Example Doc");
    expect(r[0]?.snippet).toBe("A helpful snippet here");
  });

  it("resolveProvider uses SearXNG when AMBIENT_SEARCH_URL is set, else DuckDuckGo", () => {
    expect(resolveProvider("q", { AMBIENT_SEARCH_URL: "https://searx.local/" }).name).toBe(
      "searxng",
    );
    expect(resolveProvider("q", {}).name).toBe("duckduckgo");
  });
});

describe("makeWebSearchTool", () => {
  const ctx = { signal: new AbortController().signal } as unknown as ToolContext;
  const publicLookup = async () => [{ address: "93.184.216.34" }]; // a public IP → passes the SSRF gate
  const stubFetch = (body: string) => async () =>
    ({
      status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    }) as never;

  it("is a network-effect tool that returns links the model can then web_fetch", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: stubFetch(
        JSON.stringify({ results: [{ title: "T", url: "https://t.dev", content: "s" }] }),
      ),
      lookup: publicLookup,
      env: { AMBIENT_SEARCH_URL: "https://searx.local" },
    });
    expect(tool.manifest.effects).toEqual(["network"]); // permission-gated like web_fetch
    const out = (await tool.execute({ query: "zod" }, ctx)) as {
      results: unknown[];
      provider: string;
    };
    expect(out.provider).toBe("searxng");
    expect(out.results).toEqual([{ title: "T", url: "https://t.dev", snippet: "s" }]);
  });

  it("returns an HONEST note (never a fake result) when there are no results", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: stubFetch(JSON.stringify({ results: [] })),
      lookup: publicLookup,
      env: { AMBIENT_SEARCH_URL: "https://searx.local" },
    });
    const out = (await tool.execute({ query: "zzz" }, ctx)) as {
      results: unknown[];
      note?: string;
    };
    expect(out.results).toEqual([]);
    expect(out.note).toBeTruthy();
  });
});

describe("web_search's connection", () => {
  it("goes to the vetted address and reads no more than the cap", async () => {
    const pinnedTo: string[][] = [];
    let chunksRead = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const tool = makeWebSearchTool({
      env: { AMBIENT_SEARCH_URL: "https://search.example/search?q={query}&format=json" },
      lookup: async () => [{ address: "93.184.216.34" }],
      makeDispatcher: (addrs) => {
        pinnedTo.push(addrs.map((a) => a.address));
        return { close: async () => {} };
      },
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => "application/json" },
        arrayBuffer: async () => {
          throw new Error("the body must be streamed, not buffered whole");
        },
        body: {
          getReader: () => ({
            read: async () => {
              chunksRead++;
              return { done: false, value: chunk }; // an endless body
            },
            cancel: async () => {},
          }),
        },
      }),
    });
    const ctx = { signal: new AbortController().signal } as ToolContext;
    const r = await tool.execute({ query: "zod", limit: 3 }, ctx);
    expect(pinnedTo).toEqual([["93.184.216.34"]]);
    expect(chunksRead).toBeLessThan(40); // ~2 MB, then it stops
    expect(r.results).toEqual([]);
  });
});
