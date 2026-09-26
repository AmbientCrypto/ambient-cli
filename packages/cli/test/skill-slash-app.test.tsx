import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, TurnCompletion } from "@amb/runtime";
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

describe("skills as slash commands", () => {
  it("/skill-name runs the skill with the arguments; opted-out skills aren't offered", async () => {
    const tasks: string[] = [];
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (p: ChatParams): Promise<TurnCompletion> => {
        const last = p.messages.at(-1);
        tasks.push(typeof last?.content === "string" ? last.content : "");
        return { content: "done", toolCalls: [] };
      },
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
        skills={[
          {
            name: "deploy-staging",
            source: "claude-user",
            description: "Deploy to staging",
            pinned: false,
            argumentHint: "<branch>",
          },
          {
            name: "secret-helper",
            source: "claude-user",
            description: "Internal",
            pinned: false,
            userInvocable: false,
          },
        ]}
      />,
    );
    await settle(40);
    for (const ch of "/secret") stdin.write(ch);
    await settle(60);
    expect(lastFrame()).not.toContain("secret-helper"); // opted out of /name
    stdin.write("\x15"); // Ctrl+U clears the line
    await settle(40);
    for (const ch of "/deploy") stdin.write(ch);
    await settle(60);
    expect(lastFrame()).toContain("/deploy-staging");
    expect(lastFrame()).toContain("skill · Deploy to staging");
    for (const ch of "-staging feature-x") stdin.write(ch);
    await settle(40);
    stdin.write("\r");
    await settle(300);
    expect(
      tasks.some((t) => t.includes('Use the "deploy-staging" skill') && t.includes("feature-x")),
    ).toBe(true);
    unmount();
  });
});
