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
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("model switch did not reach the running step");
    await settle(20);
  }
}
const stubWriter = () =>
  ({ append() {}, close() {}, path: "/dev/null" }) as unknown as SessionWriter;

describe("/model while a run is working", () => {
  it("switches at the next step and shows a receipt", async () => {
    const models: string[] = [];
    let call = 0;
    let finishFirst: () => void = () => {};
    const firstStep = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const client = {
      fetchCatalog: async () => [m("vendor/a"), m("vendor/b")],
      chat: async (p: ChatParams) => {
        models.push(p.model);
        call += 1;
        if (call === 1) {
          await firstStep; // release only after the UI has accepted the switch
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
    try {
      await settle(30);
      for (const ch of "look around") ui.stdin.write(ch);
      ui.stdin.write("\r");
      await waitFor(() => models.length === 1);
      for (const ch of "/model vendor/b") ui.stdin.write(ch);
      await settle(20);
      ui.stdin.write("\r");
      await waitFor(() =>
        (ui.lastFrame() ?? "").includes("switching to vendor/b at the next step"),
      );
      finishFirst();
      await waitFor(() => models.length === 2);
      expect(models).toEqual(["vendor/a", "vendor/b"]);
      await waitFor(() => (ui.lastFrame() ?? "").includes("switched to vendor/b"));
    } finally {
      finishFirst();
      ui.unmount();
    }
  });
});
