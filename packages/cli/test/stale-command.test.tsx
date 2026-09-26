import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-stalecmd-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("a slash command whose file went away", () => {
  it("doesn't run from the copy loaded at startup", async () => {
    mkdirSync(join(ws, ".ambient", "commands"), { recursive: true });
    const file = join(ws, ".ambient", "commands", "deploy.md");
    writeFileSync(file, "---\ndescription: deploy it\n---\nDEPLOY-NOW");
    const sent: string[] = [];
    const client = {
      fetchCatalog: async () => [model],
      chat: async (p: { messages: unknown[] }) => {
        sent.push(JSON.stringify(p.messages));
        return { content: "ok", toolCalls: [] };
      },
    } as unknown as ChatClient;
    const writer = {
      append: () => null,
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
        cwd={ws}
        workspaceRoot={ws}
      />,
    );
    await settle(50);
    rmSync(file);
    for (const ch of "/deploy") ui.stdin.write(ch);
    await settle(50);
    ui.stdin.write("\r");
    await settle(300);
    expect(ui.lastFrame()).toContain("isn't available any more");
    expect(sent.join("")).not.toContain("DEPLOY-NOW");
    ui.unmount();
  });
});
