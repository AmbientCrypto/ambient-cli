import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import type { FleetRow } from "../src/render/fleet.js";
import { App } from "../src/tui/App.js";

const stubClient = {
  fetchCatalog: async () => [],
  chat: async () => ({ content: "hi", toolCalls: [] }),
} as unknown as ChatClient;
const stubWriter = () => ({ append() {} }) as unknown as SessionWriter;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fleet: FleetRow[] = [
  {
    avail: "ready",
    id: "moonshotai/kimi-k2.7-code",
    ctx: "262k",
    lane: "direct",
    vision: "vision:no",
  },
  {
    avail: "cold",
    id: "qwen/qwen3.6-27b",
    ctx: "33k",
    lane: "assisted",
    vision: "vision:no",
  },
  {
    avail: "ready",
    id: "z-ai/glm-5.2",
    ctx: "203k",
    lane: "direct",
    vision: "vision:no",
  },
];

it("the /model picker lists every model, ready first; catalog-flagged ones are marked, not hidden", async () => {
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
  for (const ch of "/model") stdin.write(ch);
  await settle(40);
  stdin.write("\r"); // run the highlighted /model command → opens the picker
  await settle(60);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Pick a model"); // the picker is open
  expect(frame).toContain("kimi-k2.7-code"); // ready → shown
  expect(frame).toContain("glm-5.2"); // ready → shown
  // The readiness flag is a hint (flagged models have served live), so a flagged model stays pickable and
  // isn't labeled by it…
  expect(frame).toContain("qwen3.6-27b");
  expect(frame).not.toContain("flagged");
  // …and it sorts after the ready ones.
  expect(frame.indexOf("qwen3.6-27b")).toBeGreaterThan(frame.indexOf("glm-5.2"));
  unmount();
});
