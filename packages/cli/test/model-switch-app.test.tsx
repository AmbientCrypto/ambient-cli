import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";

const m = (id: string): CatalogModel => ({
  id,
  name: id,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedFeatures: ["tools"],
  supportedSamplingParameters: [],
  contextLength: 131_072,
  maxOutputLength: 8192,
  isReady: true,
});
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stubWriter = () =>
  ({ append() {}, close() {}, path: "/dev/null" }) as unknown as SessionWriter;

describe("/model while a run is working", () => {
  it("switches at the next step and shows a receipt", async () => {
    const models: string[] = [];
    let call = 0;
    const client = {
      fetchCatalog: async () => [m("vendor/a"), m("vendor/b")],
      chat: async (p: ChatParams) => {
        models.push(p.model);
        call += 1;
        if (call === 1) {
          await settle(250); // a slow first step — the user switches meanwhile
          return {
            content: "",
            toolCalls: [{ id: "t1", name: "list", args: { path: "." }, rawArgs: '{"path":"."}' }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    } as unknown as ChatClient;
    const ui = render(
      <App
        client={client}
        makeWriter={stubWriter}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/a"
        maxTurns={4}
        cwd={process.cwd()}
        workspaceRoot={process.cwd()}
      />,
    );
    await settle(30);
    for (const ch of "look around") ui.stdin.write(ch);
    ui.stdin.write("\r");
    await settle(60);
    for (const ch of "/model vendor/b") ui.stdin.write(ch);
    await settle(20);
    ui.stdin.write("\r");
    await settle(500);
    expect(models).toEqual(["vendor/a", "vendor/b"]);
    expect(ui.lastFrame()).toContain("switched to vendor/b");
    ui.unmount();
  });
});
