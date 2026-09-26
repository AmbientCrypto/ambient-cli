import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, HooksPort } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { WorkspaceSettings } from "../src/agent/workspace-settings.js";
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
const stubWriter = () =>
  ({ append() {}, close() {}, path: "/dev/null" }) as unknown as SessionWriter;

function mount(settings: WorkspaceSettings) {
  const requests: ChatParams[] = [];
  const client = {
    fetchCatalog: async () => [model],
    chat: async (p: ChatParams) => {
      requests.push({ ...p, messages: [...p.messages] });
      return { content: "ok", toolCalls: [] };
    },
  } as unknown as ChatClient;
  const ui = render(
    <App
      client={client}
      makeWriter={stubWriter}
      agentMode="build"
      permission="bypass"
      effort="auto"
      requestedModel="vendor/m"
      maxTurns={4}
      cwd="/nonexistent-ws"
      workspaceRoot="/nonexistent-ws"
      settings={settings}
    />,
  );
  const type = async (text: string) => {
    for (const ch of text) ui.stdin.write(ch);
    await settle(30);
    ui.stdin.write("\r");
    await settle(200);
  };
  return { ui, type, requests };
}

describe("/hooks", () => {
  it("lists the hooks and trusts the project's on request; runs use the current hooks", async () => {
    let trusted = false;
    const ports: string[] = [];
    const port: HooksPort = {
      run: async (event) => (event === "UserPromptSubmit" ? { context: "HOOK-CONTEXT" } : {}),
    };
    const hooks: WorkspaceSettings = {
      hooksPort: (sid) => {
        ports.push(sid());
        return trusted ? port : undefined;
      },
      rules: () => undefined,
      hooksSummary: () => ["1 hook will run:", "  PreToolUse(Bash) → ./guard.sh"],
      permissionsSummary: () => ["From ambient config:", "  deny   Read(./.env)"],
      trust: () => {
        trusted = true;
        return "Trusted this project's 1 hook. They apply from the next message.";
      },
      untrustedCount: () => (trusted ? 0 : 1),
      projectTrusted: () => trusted,
      trustSummary: () => [
        "This project's own settings (off until you trust them):",
        "/trust yes turns on exactly this",
      ],
    };
    const { ui, type, requests } = mount(hooks);
    await settle(30);
    await type("/hooks");
    expect(ui.lastFrame()).toContain("PreToolUse(Bash) → ./guard.sh");

    await type("/permissions");
    expect(ui.lastFrame()).toContain("deny   Read(./.env)");

    await type("first");
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("HOOK-CONTEXT");

    expect(ui.lastFrame()).toContain("Project hooks, rules, MCP servers and verify script");
    await type("/trust");
    expect(ui.lastFrame()).toContain("/trust yes turns on exactly this");
    expect(trusted).toBe(false);
    await type("/trust yes");
    expect(ui.lastFrame()).toContain("Trusted this project's 1 hook");

    await type("second");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("HOOK-CONTEXT");
    expect(ports.every((s) => s.startsWith("ses_"))).toBe(true);
    ui.unmount();
  });
});
