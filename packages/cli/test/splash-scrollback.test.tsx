import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, TurnCompletion } from "@amb/runtime";
import { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";

const catalog: CatalogModel[] = [
  {
    id: "vendor/m",
    name: "m",
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 131_072,
    maxOutputLength: 8_192,
    isReady: true,
  },
];
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("splash and scrollback", () => {
  it("a launch note is printed once, even after a menu hides the banner and the chat starts", async () => {
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (): Promise<TurnCompletion> => ({ content: "PONG", toolCalls: [] }),
    } as unknown as ChatClient;
    const { stdin, lastFrame, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={5}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );
    const send = async (text: string) => {
      for (const ch of text) stdin.write(ch);
      await settle(40);
      stdin.write("\r");
      await settle(120);
    };
    await settle(40);
    await send("/model vendor/m"); // a one-line note ("model → vendor/m") while the banner is up
    expect(lastFrame()).toContain("model → vendor/m");
    expect(lastFrame()).toContain("A terminal coding agent"); // the banner is still there
    await send("/model"); // a picker hides the banner for a moment
    stdin.write("\u001b");
    await settle(80);
    await send("ping");
    await settle(200);
    expect(lastFrame()).toContain("PONG");
    // Everything <Static> printed plus the live frame: the note appears exactly once.
    expect(count(lastFrame() ?? "", "model → vendor/m")).toBe(1);
    unmount();
  });
});

describe("/clear", () => {
  it("starts the token counts, context use and run status over", async () => {
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (): Promise<TurnCompletion> =>
        ({
          content: "PONG",
          toolCalls: [],
          usage: { promptTokens: 5_000, completionTokens: 100 },
        }) as TurnCompletion,
    } as unknown as ChatClient;
    const { stdin, lastFrame, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={5}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );
    const send = async (text: string) => {
      for (const ch of text) stdin.write(ch);
      await settle(40);
      stdin.write("\r");
      await settle(200);
    };
    await settle(40);
    await send("ping");
    expect(lastFrame()).toMatch(/5\.1k tok/);
    expect(lastFrame()).toMatch(/complete/);
    await send("/clear");
    expect(lastFrame()).not.toMatch(/5\.1k tok/);
    // The last run's outcome and context use belong to the cleared conversation.
    expect(lastFrame()).not.toMatch(/complete/);
    expect(lastFrame()).toMatch(/ready/);
    unmount();
  });
});
