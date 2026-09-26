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
