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

function mount() {
  let calls = 0;
  const client = {
    fetchCatalog: async () => catalog,
    chat: async (): Promise<TurnCompletion> => {
      calls += 1;
      return { content: "done", toolCalls: [] };
    },
  } as unknown as ChatClient;
  const ui = render(
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
      listFiles={async () => ["src/app.ts", "src/parser.ts", "README.md"]}
    />,
  );
  return { ...ui, calls: () => calls };
}
const type = async (stdin: { write: (s: string) => void }, text: string) => {
  for (const ch of text) stdin.write(ch);
  await settle(60);
};

describe("@ file picker", () => {
  it("offers matching files and Tab puts the chosen path in the message", async () => {
    const { stdin, lastFrame, calls, unmount } = mount();
    await settle(40);
    await type(stdin, "fix @");
    await settle(60); // the list loads on first use
    await type(stdin, "pars");
    expect(lastFrame()).toContain("Files · ↑/↓ then tab or enter");
    expect(lastFrame()).toContain("▸ src/parser.ts");
    stdin.write("\t");
    await settle(40);
    expect(lastFrame()).toContain("fix @src/parser.ts");
    expect(lastFrame()).not.toContain("Files ·");
    expect(calls()).toBe(0);
    unmount();
  });
  it("Enter picks a file instead of sending, and Esc closes the picker", async () => {
    const { stdin, lastFrame, calls, unmount } = mount();
    await settle(40);
    await type(stdin, "@");
    await settle(60);
    await type(stdin, "app");
    expect(lastFrame()).toContain("▸ src/app.ts");
    stdin.write("\r");
    await settle(40);
    expect(lastFrame()).toContain("@src/app.ts");
    expect(calls()).toBe(0);
    await type(stdin, "and @READ");
    stdin.write("\u001b");
    await settle(60);
    expect(lastFrame()).not.toContain("Files ·");
    unmount();
  });
  it("stays out of the / menu: Enter runs the command, the file text is just an argument", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await settle(40);
    await type(stdin, "@"); // load the list once
    await settle(60);
    stdin.write("\x15"); // clear
    await settle(20);
    await type(stdin, "/usage @pars");
    expect(lastFrame()).not.toContain("Files ·");
    stdin.write("\r");
    await settle(80);
    expect(lastFrame()).toContain("Usage");
    unmount();
  });
  it("a recalled prompt ending in a mention doesn't trap the arrows or Enter", async () => {
    const history = ["older prompt", "fix @src/app.ts"];
    let calls = 0;
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (): Promise<TurnCompletion> => {
        calls += 1;
        return { content: "done", toolCalls: [] };
      },
    } as unknown as ChatClient;
    const ui = render(
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
        listFiles={async () => ["src/app.ts"]}
        history={{ load: () => history, append: () => {} }}
      />,
    );
    await settle(40);
    ui.stdin.write("\u001b[A"); // ↑ → "fix @src/app.ts"
    await settle(60);
    expect(ui.lastFrame()).toContain("fix @src/app.ts");
    expect(ui.lastFrame()).not.toContain("Files ·");
    ui.stdin.write("\u001b[A"); // ↑ again → the older prompt
    await settle(60);
    expect(ui.lastFrame()).toContain("older prompt");
    ui.stdin.write("\u001b[B"); // ↓ back
    await settle(60);
    ui.stdin.write("\r"); // Enter sends it
    await settle(200);
    expect(calls).toBe(1);
    ui.unmount();
  });
});
