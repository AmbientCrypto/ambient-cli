import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, TurnCompletion } from "@amb/runtime";
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
const stubWriter = () =>
  ({ append() {}, close() {}, path: "/dev/null" }) as unknown as SessionWriter;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 12_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await settle(25);
  }
};

describe("a message sent while subagents work", () => {
  it("waits for them, says so, and Enter on an empty line has them wrap up so the agent reads it", async () => {
    const parentRequests: ChatParams[] = [];
    let childTurns = 0;
    const client = {
      fetchCatalog: async () => [model],
      chat: async (p: ChatParams): Promise<TurnCompletion> => {
        const isChild =
          !JSON.stringify(p.tools).includes('"subagent"') &&
          JSON.stringify(p.messages).includes("MAP THE CODE");
        if (isChild) {
          // A scout that keeps looking until it's told to report.
          if (p.tools.length === 0) return { content: "SCOUT REPORT", toolCalls: [] };
          childTurns += 1;
          await settle(120);
          return {
            content: "",
            toolCalls: [
              {
                id: `c${childTurns}`,
                name: "list",
                args: { path: "." },
                rawArgs: `{"n":${childTurns}}`,
              },
            ],
          };
        }
        parentRequests.push({ ...p, messages: [...p.messages] });
        if (parentRequests.length === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "tc_sub",
                name: "subagent",
                args: { spawn: [{ label: "scout", role: "scout", prompt: "MAP THE CODE" }] },
                rawArgs: "{}",
              },
            ],
          };
        }
        return { content: "PARENT DONE", toolCalls: [] };
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
        maxTurns={6}
        cwd={process.cwd()}
        workspaceRoot={process.cwd()}
      />,
    );
    await settle(30);
    for (const ch of "explore") ui.stdin.write(ch);
    ui.stdin.write("\r");
    await waitFor(() => childTurns >= 1);
    for (const ch of "what are they doing") ui.stdin.write(ch);
    ui.stdin.write("\r");
    await waitFor(() => (ui.lastFrame() ?? "").includes("when the subagents report"));
    ui.stdin.write("\r"); // empty line: ask them to wrap up
    await waitFor(() => (ui.lastFrame() ?? "").includes("Asking the subagents to wrap up"));
    await waitFor(() => (ui.lastFrame() ?? "").includes("PARENT DONE"));
    expect(JSON.stringify(parentRequests.at(-1)?.messages)).toContain("what are they doing");
    expect(childTurns).toBeLessThan(20);
    ui.unmount();
  }, 30_000);
});
