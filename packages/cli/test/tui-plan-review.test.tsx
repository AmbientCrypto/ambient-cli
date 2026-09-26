import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
/** Everything the model is given as system context for this request (the prompt plus trailing notes such as
 *  the current plan). */
// What the agent is told besides the user's words: the system prompt, and notes from ambient (a note after
// the conversation starts travels in a user turn — some models reject a late system message).
const systemText = (p: ChatParams): string =>
  p.messages
    .filter((m) => typeof m.content === "string")
    .flatMap((m) =>
      m.role === "system"
        ? [m.content as string]
        : [...(m.content as string).matchAll(/<ambient-note>([\s\S]*?)<\/ambient-note>/g)].map(
            (x) => x[1] ?? "",
          ),
    )
    .join("\n");
const lastUserText = (p: ChatParams): string => {
  const users = p.messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  return typeof last?.content === "string" ? last.content : "";
};

const PLAN_CALL: TurnCompletion = {
  content: "",
  toolCalls: [
    {
      id: "p1",
      name: "plan",
      args: {
        tasks: [
          { text: "Add the parser", status: "pending" },
          { text: "Add tests", status: "pending" },
        ],
      },
      rawArgs: JSON.stringify({
        tasks: [
          { text: "Add the parser", status: "pending" },
          { text: "Add tests", status: "pending" },
        ],
      }),
    },
  ],
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "amb-planreview-"));
  process.env.AMB_HOME = home;
});
afterEach(() => {
  process.env.AMB_HOME = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("plan review — a prominent approve/revise prompt when a plan is ready", () => {
  it("shows the approve/revise banner after a PLAN run; empty Enter APPROVES → switches to Build + executes", async () => {
    const modes: string[] = [];
    const userTexts: string[] = [];
    let call = 0;
    const chat: ChatClient["chat"] = async (params): Promise<TurnCompletion> => {
      modes.push(systemText(params).includes("PLAN MODE") ? "plan" : "build");
      userTexts.push(lastUserText(params));
      call += 1;
      if (call === 1) return PLAN_CALL; // plan-mode: record the plan…
      return { content: `DONE${call}`, toolCalls: [] }; // …then finish (and later, the build run)
    };
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="plan"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );

    await settle(40);
    for (const ch of "plan a change") stdin.write(ch);
    await settle(30);
    stdin.write("\r");

    // ONE clear prompt on the composer (not two overlapping banners).
    const banner = await waitFor(lastFrame, "Plan ready");
    expect(banner).toContain("approve & build");
    expect(banner).toContain("revise");
    // Exactly one plan-review affordance — the separate bordered banner is gone, so "PLAN READY" appears once.
    expect((banner.match(/Plan ready/g) ?? []).length).toBe(1);

    // Empty Enter APPROVES → flips to Build and executes the plan (DONE3 = the build run's answer; DONE2 was
    // the plan run's).
    stdin.write("\r");
    await waitFor(lastFrame, "DONE3");

    // The approving run ran in BUILD mode and its instruction is to execute the prepared plan.
    expect(modes[modes.length - 1]).toBe("build");
    expect(userTexts[userTexts.length - 1]).toContain("Execute the plan");
    expect(userTexts[userTexts.length - 1]).toContain("Add the parser");
    unmount();
  });

  it("typing feedback REVISES the plan in place — the run stays in PLAN mode and sees the current plan pinned", async () => {
    const modes: string[] = [];
    const systemsAtCall: string[] = [];
    let call = 0;
    const chat: ChatClient["chat"] = async (params): Promise<TurnCompletion> => {
      const sys = systemText(params);
      modes.push(sys.includes("PLAN MODE") ? "plan" : "build");
      systemsAtCall.push(sys);
      call += 1;
      if (call === 1) return PLAN_CALL;
      return { content: `DONE${call}`, toolCalls: [] };
    };
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="plan"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );

    await settle(40);
    for (const ch of "plan a change") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "Plan ready");

    // Typing feedback + Enter revises — the run stays in PLAN mode and the current plan is pinned so the
    // agent reads it and adjusts (not a from-scratch replan, and it survives compaction).
    for (const ch of "drop the tests step") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "DONE");

    expect(modes[modes.length - 1]).toBe("plan"); // still planning — NOT flipped to build
    const reviseSys = systemsAtCall[systemsAtCall.length - 1] ?? "";
    expect(reviseSys).toContain("## Current plan"); // the current plan is pinned for the revision run…
    expect(reviseSys).toContain("Add the parser"); // …so the agent reads it and edits, no hallucinating
    unmount();
  });

  it("/clear retires the review prompt — a later empty Enter can NOT silently execute the stale plan", async () => {
    let call = 0;
    const chat: ChatClient["chat"] = async (params): Promise<TurnCompletion> => {
      call += 1;
      if (call === 1) return PLAN_CALL;
      return { content: `DONE${call}`, toolCalls: [] };
    };
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="plan"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );

    await settle(40);
    for (const ch of "plan a change") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "Plan ready");

    // /clear wipes the screen and starts a fresh session; the kept plan is now stale.
    for (const ch of "/clear") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await settle(60);

    // An empty Enter now must do NOTHING — the review prompt is retired, so it can't flip to build and
    // silently execute the stale plan in the fresh session. (The banner is dynamic and gone; the earlier
    // scrollback notice persists via Ink <Static>, so we assert the BEHAVIOUR, not the frame text.)
    const callsBefore = call;
    stdin.write("\r");
    await settle(80);
    expect(call).toBe(callsBefore); // no new run was started
    unmount();
  });

  it("an image + empty Enter during plan review REVISES with the image — never a silent flip to build", async () => {
    const modes: string[] = [];
    let call = 0;
    const chat: ChatClient["chat"] = async (params): Promise<TurnCompletion> => {
      modes.push(systemText(params).includes("PLAN MODE") ? "plan" : "build");
      call += 1;
      if (call === 1) return PLAN_CALL;
      return { content: `DONE${call}`, toolCalls: [] };
    };
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

    // A valid 1x1 PNG so /attach accepts it (a tiny image short-circuits downscale — no `sips` needed).
    const pngPath = join(home, "shot.png");
    writeFileSync(
      pngPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="plan"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );

    await settle(40);
    for (const ch of "plan a change") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "Plan ready");

    // Attach an image while the plan-review prompt is up.
    for (const ch of `/attach ${pngPath}`) stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "image attached");

    // Empty Enter WITH an image is not an approval — it runs a PLAN-mode revision that includes the image,
    // never a silent flip to Build (which could edit files) with an empty instruction.
    stdin.write("\r");
    await waitFor(lastFrame, "DONE");
    expect(modes[modes.length - 1]).toBe("plan");
    unmount();
  });
});
