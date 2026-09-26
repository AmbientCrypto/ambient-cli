import type { CatalogModel } from "@amb/protocol";
import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import type { FleetRow } from "../src/render/fleet.js";
import { App } from "../src/tui/App.js";

// A ready one-model catalog so a REAL turn actually runs to completion (an empty catalog errors before
// turn.started, which would leave the layout asserting on the splash frame rather than a running one).
const catalog: CatalogModel[] = [
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "kimi",
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 262_144,
    maxOutputLength: 262_144,
    isReady: true,
  },
];
const stubClient = {
  fetchCatalog: async () => catalog,
  chat: async () => ({ content: "hello from the model", toolCalls: [] }),
} as unknown as ChatClient;
const stubWriter = () => ({ append() {} }) as unknown as SessionWriter;
const fleet: FleetRow[] = [
  {
    avail: "ready",
    id: "moonshotai/kimi-k2.7-code",
    ctx: "262k",
    lane: "direct",
    vision: "vision:no",
  },
];

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until the run SETTLES — the model's answer is on screen and the composer is back to idle — so the
 *  assertion inspects a genuine post-run running-layout frame, never a mid-run (busy composer) snapshot. */
async function waitForSettled(lastFrame: () => string | undefined): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const f = lastFrame() ?? "";
    if (f.includes("hello from the model") && f.includes("Describe a coding task")) return f;
    await settle(25);
  }
  return lastFrame() ?? "";
}

it("running layout is BOTTOM-anchored — empty space at the top, composer + flightline pinned at the bottom", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App
      client={stubClient}
      makeWriter={stubWriter}
      agentMode="build"
      permission="ask"
      effort="auto"
      requestedModel="auto"
      maxTurns={30}
      cwd="/w"
      workspaceRoot="/w"
      fleet={fleet}
    />,
  );
  await settle(40);
  stdin.write("hey");
  await settle(40);
  stdin.write("\r"); // submit → a user item enters the transcript → running (non-splash) layout
  const frame = await waitForSettled(lastFrame);

  const lines = frame.split("\n");
  const lastNonBlank =
    lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim().length > 0);
  const answerRow = lines.findIndex((l) => l.includes("hello from the model"));
  const composerRow = lines.findIndex((l) => l.includes("Describe a coding task"));
  // Scrollback model: the settled turn (the model's answer) is committed ABOVE, the composer + flightline
  // flow BELOW it and the flightline is the very last line — a normal terminal log, not a fixed viewport.
  expect(answerRow).toBeGreaterThanOrEqual(0); // the answer is on screen (committed to scrollback)
  expect(composerRow).toBeGreaterThan(answerRow); // history above, the input below it
  expect(lines[lastNonBlank]).toContain("BUILD"); // the flightline sits at the very bottom
  unmount();
});

it("an `auto` pick does NOT emit a 'no model requested' substitution receipt", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App
      client={stubClient}
      makeWriter={stubWriter}
      agentMode="build"
      permission="ask"
      effort="auto"
      requestedModel="auto"
      maxTurns={30}
      cwd="/w"
      workspaceRoot="/w"
      fleet={fleet}
    />,
  );
  await settle(40);
  stdin.write("hey");
  await settle(40);
  stdin.write("\r");
  const frame = await waitForSettled(lastFrame);
  // The default auto-pick is not a substitution — the flightline shows "←auto"; a transcript receipt saying
  // "you asked for auto (no model requested)" is confusing noise and must not appear.
  expect(frame).not.toContain("no model requested");
  expect(frame).not.toContain("you asked for auto");
  unmount();
});
