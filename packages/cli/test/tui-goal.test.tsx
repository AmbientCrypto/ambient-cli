import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, TurnCompletion } from "@amb/runtime";
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
const systemText = (p: ChatParams): string => {
  const s = p.messages.find((m) => m.role === "system");
  return typeof s?.content === "string" ? s.content : "";
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "amb-goal-tui-"));
  process.env.AMB_HOME = home;
});
afterEach(() => {
  process.env.AMB_HOME = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("/goal — set → shows in the UI → reaches the run → persists", () => {
  it("threads the north-star into the run's system prompt and records a goal.set", async () => {
    const systems: string[] = [];
    const chat: ChatClient["chat"] = async (params) => {
      systems.push(systemText(params));
      return { content: "OK", toolCalls: [] };
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
    for (const ch of "/goal ship the CSV export") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    // Wait for the goal to actually be SET — the ◎ pin marker only appears after Enter processes the
    // command (waiting for the objective text alone would match it while it's still in the composer input,
    // before submit — a race React's render timing can expose).
    const withGoal = await waitFor(lastFrame, "◎");
    expect(withGoal).toContain("ship the CSV export");

    // Run a task — the goal must be pinned in the system prompt the model receives.
    for (const ch of "do it") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "OK");

    expect(systems.length).toBe(1);
    expect(systems[0]).toContain("NORTH-STAR GOAL");
    expect(systems[0]).toContain("ship the CSV export");

    // The goal.set was durably recorded (so `amb resume` can restore it).
    const files = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);
    const log = readFileSync(join(home, "sessions", files[0] as string), "utf8");
    expect(log).toContain('"kind":"goal.set"');
    expect(log).toContain("ship the CSV export");

    unmount();
  });

  it("/goal clear removes the north-star from the next run", async () => {
    const systems: string[] = [];
    const chat: ChatClient["chat"] = async (params) => {
      systems.push(systemText(params));
      return { content: "OK", toolCalls: [] };
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
    for (const ch of "/goal temporary aim") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "temporary aim");
    for (const ch of "/goal clear") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await settle(40);

    for (const ch of "go") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "OK");

    expect(systems[systems.length - 1]).not.toContain("NORTH-STAR GOAL");
    unmount();
  });

  it("propose_goal_update: model proposes → user approves → pinned goal updates → next run carries it", async () => {
    const systems: string[] = [];
    let call = 0;
    const chat: ChatClient["chat"] = async (params): Promise<TurnCompletion> => {
      systems.push(systemText(params));
      call += 1;
      // Turn 1, first model step: propose a new goal (a real tool call).
      if (call === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "g1",
              name: "propose_goal_update",
              args: { objective: "migrate to Postgres", reason: "SQLite won't scale" },
              rawArgs: JSON.stringify({
                objective: "migrate to Postgres",
                reason: "SQLite won't scale",
              }),
            },
          ],
        };
      }
      return { content: `OK${call}`, toolCalls: [] };
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
    // Start with an initial goal so this is a genuine UPDATE.
    for (const ch of "/goal use SQLite") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "use SQLite");

    // Run a task — the model proposes a goal update, which opens the confirmation overlay.
    for (const ch of "do the migration") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "Update the north-star goal?");
    // The default cursor is on "Use this as the goal" — Enter approves it.
    stdin.write("\r");
    await waitFor(lastFrame, "migrate to Postgres"); // the pinned goal line now shows the approved goal

    // A follow-up run must carry the NEW goal in its system prompt.
    for (const ch of "continue") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "OK3");
    expect(systems[systems.length - 1]).toContain("migrate to Postgres");
    expect(systems[systems.length - 1]).not.toContain("use SQLite");

    unmount();
  });
});
