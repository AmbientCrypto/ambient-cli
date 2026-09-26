import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, TurnCompletion } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
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
    maxOutputLength: 262_144,
    isReady: true,
  },
];
const stubWriter = () => ({ append() {} }) as unknown as SessionWriter;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(lastFrame: () => string | undefined, needle: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const f = lastFrame() ?? "";
    if (f.includes(needle)) return f;
    await settle(20);
  }
  return lastFrame() ?? "";
}

it("ask_user: the model asks → overlay opens → the answer (choice + note) flows back to the model", async () => {
  // Turn 1: the model calls ask_user. Turn 2 (after the answer arrives as the tool result): it echoes what
  // it heard so we can assert the human's choice + note round-tripped through the tool.
  let turn = 0;
  const chat: ChatClient["chat"] = async (params): Promise<TurnCompletion> => {
    turn++;
    if (turn === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "tc_ask",
            name: "ask_user",
            args: {
              question: "What platform should this 2048 game target?",
              options: [{ label: "Web app" }, { label: "iOS app" }, { label: "macOS app" }],
              allowText: true,
            },
            rawArgs: JSON.stringify({ question: "…" }),
          },
        ],
      };
    }
    // The tool result (the human's answer) is now in the messages — surface it as the final text.
    const toolMsg = [...params.messages].reverse().find((m) => m.role === "tool");
    const heard =
      typeof toolMsg?.content === "string" ? toolMsg.content : JSON.stringify(toolMsg?.content);
    return { content: `HEARD:${heard}`, toolCalls: [] };
  };
  const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

  const { lastFrame, stdin, unmount } = render(
    <App
      client={client}
      makeWriter={stubWriter}
      agentMode="build"
      permission="ask"
      effort="auto"
      requestedModel="vendor/m"
      maxTurns={30}
      cwd="/w"
      workspaceRoot="/w"
    />,
  );
  await settle(40);
  stdin.write("build me a 2048 game");
  await settle(40);
  stdin.write("\r");

  // The questionnaire overlay opens with the question + options.
  const q = await waitFor(lastFrame, "What platform should this 2048 game target?");
  expect(q).toContain("Web app");
  expect(q).toContain("iOS app");
  expect(q).toContain("esc skip");

  // Move the cursor to "iOS app" (down once) and type a note.
  stdin.write("[B"); // down arrow → cursor on iOS app
  await settle(30);
  for (const ch of "budget matters") stdin.write(ch);
  await settle(40);
  stdin.write("\r"); // submit

  // The model's next turn echoes the tool result — it must contain the selected option AND the note.
  const done = await waitFor(lastFrame, "HEARD:");
  expect(done).toContain("iOS app");
  expect(done).toContain("budget matters");
  unmount();
});

it("ask_user: Esc skips the question and the agent proceeds", async () => {
  let turn = 0;
  const chat: ChatClient["chat"] = async (params): Promise<TurnCompletion> => {
    turn++;
    if (turn === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "tc_ask",
            name: "ask_user",
            args: { question: "Ship it now?", options: [{ label: "Yes" }, { label: "No" }] },
            rawArgs: "{}",
          },
        ],
      };
    }
    const toolMsg = [...params.messages].reverse().find((m) => m.role === "tool");
    const heard =
      typeof toolMsg?.content === "string" ? toolMsg.content : JSON.stringify(toolMsg?.content);
    return { content: `HEARD:${heard}`, toolCalls: [] };
  };
  const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;
  const { lastFrame, stdin, unmount } = render(
    <App
      client={client}
      makeWriter={stubWriter}
      agentMode="build"
      permission="ask"
      effort="auto"
      requestedModel="vendor/m"
      maxTurns={30}
      cwd="/w"
      workspaceRoot="/w"
    />,
  );
  await settle(40);
  stdin.write("ready?");
  await settle(40);
  stdin.write("\r");
  await waitFor(lastFrame, "Ship it now?");
  stdin.write(""); // Esc → skip
  const done = await waitFor(lastFrame, "HEARD:");
  expect(done.toLowerCase()).toContain("proceed"); // the tool told the model to proceed on best judgment
  unmount();
});
