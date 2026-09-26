import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams } from "@amb/runtime";
import { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(lastFrame: () => string | undefined, needle: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    const f = lastFrame() ?? "";
    if (f.includes(needle)) return f;
    await settle(20);
  }
  return lastFrame() ?? "";
}

/** The system message a run sent (first message, role "system") — where resumeContext is injected. */
function systemText(params: ChatParams): string {
  const sys = params.messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "amb-continuity-"));
  process.env.AMB_HOME = home;
});
afterEach(() => {
  process.env.AMB_HOME = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("TUI session continuity (one session per launch, prior turns remembered)", () => {
  it("carries turn 1's REAL messages into turn 2 (lossless), not a system reconstruction, and writes ONE log", async () => {
    const calls: ChatParams[] = [];
    let turn = 0;
    const chat: ChatClient["chat"] = async (params) => {
      // Snapshot at send time (the runtime pushes the final assistant message after this returns).
      calls.push({ ...params, messages: params.messages.map((m) => ({ ...m })) });
      turn += 1;
      return { content: `ANSWER-${turn}`, toolCalls: [] };
    };
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass" // no approval overlay — a clean two-turn run
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );

    await settle(40);
    for (const ch of "remember the widget count is 42") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "ANSWER-1");

    for (const ch of "what did I say") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "ANSWER-2");

    expect(calls.length).toBe(2);
    const contents = (p: ChatParams): string[] =>
      p.messages.map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      );

    // Turn 1 has NO prior conversation (no earlier answer visible).
    expect(contents(calls[0] as ChatParams).some((c) => c.includes("ANSWER"))).toBe(false);

    // Turn 2 carries turn 1's REAL user message AND the assistant's actual answer — the lossless conversation,
    // not the old lossy text reconstruction folded into the system prompt.
    const t2 = contents(calls[1] as ChatParams);
    expect(t2.some((c) => c.includes("remember the widget count is 42"))).toBe(true);
    expect(t2.some((c) => c.includes("ANSWER-1"))).toBe(true);
    expect(systemText(calls[1] as ChatParams)).not.toContain("Prior session"); // no reconstruction block used

    // Exactly ONE durable session log for the whole launch (not one file per submit).
    const files = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);

    unmount();
  });

  it("/clear starts a fresh session — new log, no memory of the cleared conversation", async () => {
    const systems: string[] = [];
    let turn = 0;
    const chat: ChatClient["chat"] = async (params) => {
      systems.push(systemText(params));
      turn += 1;
      return { content: `ANSWER-${turn}`, toolCalls: [] };
    };
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );

    await settle(40);
    for (const ch of "the secret code is banana") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "ANSWER-1");

    // /clear → fresh conversation.
    for (const ch of "/clear") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await settle(40);

    for (const ch of "what is the code") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "ANSWER-2");

    // The post-clear turn must NOT carry the pre-clear conversation, and it lives in a NEW session file.
    expect(systems[1]).not.toContain("banana");
    const files = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(2);

    unmount();
  });

  it("renders a full turn under Ink 7 / React 19 — the answer stays visible and the composer follows it", async () => {
    // A post-migration smoke check: the committed answer stays on screen (in <Static>) and the composer is
    // rendered after it. (This asserts the natural inline layout, NOT a bottom-anchor — ink-testing-library
    // runs Ink in debug mode, so it can't exercise the interactive CSI-3J/overflow path anyway.)
    const chat: ChatClient["chat"] = async () => ({ content: "VISIBLE-ANSWER", toolCalls: [] });
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;
    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );
    await settle(40);
    for (const ch of "hi") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "VISIBLE-ANSWER");
    const frame = lastFrame() ?? "";
    // The bottom spacer must NOT scroll the just-finished answer off-screen (the earlier full-height attempt
    // did exactly that — "flashed then went away"). The answer stays visible AND the composer is still shown.
    expect(frame).toContain("VISIBLE-ANSWER");
    expect(frame).toContain("Describe a coding task");
    unmount();
  });
});
