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
    contextLength: 262_144,
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
    />,
  );
  return { ...ui, calls: () => calls };
}

const type = async (stdin: { write: (s: string) => void }, text: string) => {
  for (const ch of text) stdin.write(ch);
  await settle(40);
};

describe("composer editing keys", () => {
  it("Ctrl+W deletes the previous word and Ctrl+U the whole line", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await settle(40);
    await type(stdin, "fix the parser");
    stdin.write("\x17"); // Ctrl+W
    await settle(40);
    expect(lastFrame()).toContain("fix the ");
    expect(lastFrame()).not.toContain("parser");
    stdin.write("\x15"); // Ctrl+U
    await settle(40);
    expect(lastFrame()).not.toContain("fix the");
    unmount();
  });
  it("a line ending in \\ continues onto a new line instead of sending", async () => {
    const { stdin, lastFrame, calls, unmount } = mount();
    await settle(40);
    await type(stdin, "first part \\");
    stdin.write("\r");
    await settle(40);
    await type(stdin, "second part");
    expect(calls()).toBe(0);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("first part");
    expect(frame).toContain("second part");
    expect(frame).not.toContain("part \\");
    unmount();
  });
});
