import type { CatalogModel } from "@amb/protocol";
import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";

const model: CatalogModel = {
  id: "vendor/m",
  name: "m",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedFeatures: ["tools"],
  supportedSamplingParameters: [],
  contextLength: 128_000,
  maxOutputLength: 8192,
  isReady: true,
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a session log that can't record the goal", () => {
  it("says so, and the TUI keeps working", async () => {
    let chats = 0;
    const client = {
      fetchCatalog: async () => [model],
      chat: async () => {
        chats++;
        return { content: "ok", toolCalls: [] };
      },
    } as unknown as ChatClient;
    const writer = {
      append(ev: { kind: string }) {
        if (ev.kind === "goal.set") throw new Error("no space left on device");
        return null;
      },
      close() {},
      path: "/dev/null",
    } as unknown as SessionWriter;
    const ui = render(
      <App
        client={client}
        makeWriter={() => writer}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={4}
        cwd="/nonexistent-ws"
        workspaceRoot="/nonexistent-ws"
        initialGoal="ship it"
      />,
    );
    const type = async (text: string) => {
      for (const ch of text) ui.stdin.write(ch);
      await settle(30);
      ui.stdin.write("\r");
      await settle(300);
    };
    await settle(30);
    await type("first");
    expect(ui.lastFrame()).toContain("couldn't record the goal");
    await type("second");
    expect(chats).toBeGreaterThanOrEqual(2);
    ui.unmount();
  });
});
