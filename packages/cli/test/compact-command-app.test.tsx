import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, TurnCompletion } from "@amb/runtime";
import { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";

const catalog: CatalogModel[] = [
  {
    id: "vendor/small",
    name: "small",
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 32_768,
    maxOutputLength: 4_096,
    isReady: true,
  },
];
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(lastFrame: () => string | undefined, needle: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const f = lastFrame() ?? "";
    if (f.includes(needle)) return f;
    await settle(20);
  }
  return lastFrame() ?? "";
}

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-compact-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("/compact, /context and /usage in the app", () => {
  it("summarizes the conversation on request and reports tokens, never money", async () => {
    const calls: ChatParams[] = [];
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (p: ChatParams): Promise<TurnCompletion> => {
        calls.push(p);
        const isSummary = p.messages.some(
          (m) =>
            typeof m.content === "string" && m.content.startsWith("Summarize the conversation"),
        );
        if (isSummary) return { content: "## Goal\nexplain\n## Progress\ndone", toolCalls: [] };
        return {
          content: `ANSWER ${calls.length} ${"long explanation ".repeat(1_200)}`,
          toolCalls: [],
          usage: { promptTokens: 9_000, completionTokens: 5_000, cachedTokens: 8_000 },
        } as TurnCompletion;
      },
    } as unknown as ChatClient;
    const { stdin, lastFrame, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/small"
        maxTurns={5}
        cwd={ws}
        workspaceRoot={ws}
      />,
    );
    const send = async (text: string, until: string) => {
      for (const ch of text) stdin.write(ch);
      await settle(30);
      stdin.write("\r");
      await waitFor(lastFrame, until);
      await settle(60);
    };
    await settle(40);
    await send("explain the parser", "ANSWER 1");
    await send("and the lexer", "ANSWER 2");
    const before = calls.length;
    await send("/compact the lexer", "compacted the conversation");
    expect(lastFrame()).toContain("compacted the conversation");
    // The receipt says how full the context gauge is now, so the drop is visible.
    const fill = /context (\d+)% → (\d+)%/.exec(lastFrame() ?? "");
    expect(fill).not.toBeNull();
    expect(Number(fill?.[2])).toBeLessThan(Number(fill?.[1]));
    // …and the gauge in the status line shows the same number (the receipt plus the gauge).
    expect((lastFrame() ?? "").split(` ${fill?.[2]}%`).length - 1).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBe(before + 1);
    const instruction = String(calls.at(-1)?.messages[0]?.content);
    expect(instruction).toContain("focus on: the lexer");

    await send("/usage", "Usage");
    expect(lastFrame()).toMatch(/Usage · this session · \d+ requests?/);
    expect(lastFrame()).not.toMatch(/\$/);
    await send("/context", "Context");
    expect(lastFrame()).toContain("32.8k window");
    // One receipt for the compaction, not two.
    expect(lastFrame()).not.toContain("compacted context (");
    unmount();
  });
  it("says a short conversation isn't worth compacting, without calling a model", async () => {
    let calls = 0;
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (): Promise<TurnCompletion> => {
        calls += 1;
        return { content: `short answer ${calls}`, toolCalls: [] };
      },
    } as unknown as ChatClient;
    const { stdin, lastFrame, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/small"
        maxTurns={5}
        cwd={ws}
        workspaceRoot={ws}
      />,
    );
    const send = async (text: string, until: string) => {
      for (const ch of text) stdin.write(ch);
      await settle(30);
      stdin.write("\r");
      await waitFor(lastFrame, until);
      await settle(60);
    };
    await settle(40);
    await send("one", "short answer 1");
    await send("two", "short answer 2");
    await send("/compact", "nothing worth compacting");
    expect(lastFrame()).toMatch(/only \d+ tokens — nothing worth compacting yet/);
    expect(calls).toBe(2);
    unmount();
  });
  it("a message typed while compacting runs once the compaction is done", async () => {
    const tasks: string[] = [];
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (p: ChatParams): Promise<TurnCompletion> => {
        const isSummary = p.messages.some(
          (m) =>
            typeof m.content === "string" && m.content.startsWith("Summarize the conversation"),
        );
        if (isSummary) {
          await settle(300); // a summary that takes a moment
          return { content: "## Goal\nx", toolCalls: [] };
        }
        const last = p.messages.at(-1);
        tasks.push(typeof last?.content === "string" ? last.content.slice(0, 20) : "");
        return { content: `ANSWER ${"long text ".repeat(1_200)}`, toolCalls: [] };
      },
    } as unknown as ChatClient;
    const { stdin, lastFrame, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/small"
        maxTurns={5}
        cwd={ws}
        workspaceRoot={ws}
      />,
    );
    const typeAndEnter = async (text: string) => {
      for (const ch of text) stdin.write(ch);
      await settle(30);
      stdin.write("\r");
    };
    await settle(40);
    await typeAndEnter("first");
    await waitFor(lastFrame, "ANSWER");
    await settle(80);
    await typeAndEnter("second");
    await settle(300);
    await typeAndEnter("/compact");
    await settle(60);
    await typeAndEnter("follow up"); // typed while the summary is being written
    await waitFor(lastFrame, "compacted the conversation");
    await settle(400);
    expect(tasks.some((t) => t.startsWith("follow up"))).toBe(true);
    unmount();
  });
});
