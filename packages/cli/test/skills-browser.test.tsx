import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import { App } from "../src/tui/App.js";
import type { SkillRow } from "../src/tui/components/SkillsBrowser.js";

const stubClient = {
  fetchCatalog: async () => [],
  chat: async () => ({ content: "hi", toolCalls: [] }),
} as unknown as ChatClient;
const stubWriter = () => ({ append() {} }) as unknown as SessionWriter;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A pool bigger than the row cap so the "N above / N below" windowing is exercised.
const skills: SkillRow[] = Array.from({ length: 12 }, (_, i) => ({
  name: `skill-${i}`,
  source: i % 2 === 0 ? "you" : "claude",
  description: `does thing number ${i}`,
  pinned: i === 0,
}));

async function openBrowser(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<string> {
  await settle(40);
  stdin.write("/skills");
  await settle(30);
  stdin.write("\r"); // run the highlighted /skills command → opens the browser overlay
  for (let i = 0; i < 60; i++) {
    const f = lastFrame() ?? "";
    if (f.includes("Skills ·")) return f;
    await settle(25);
  }
  return lastFrame() ?? "";
}

it("the /skills browser renders its own header + filter lines on a short (24-row) terminal — no overlap", async () => {
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
      skills={skills}
      skillsInfo={{ total: skills.length, pinned: 1 }}
      onTogglePin={() => true}
    />,
  );
  const frame = await openBrowser(stdin, lastFrame);
  const lines = frame.split("\n");

  // The header (count + hotkeys) and the filter line are DISTINCT rows — the splash-banner overflow used to
  // collapse them onto one garbled line. Both must be present, and the header must not carry "filter:".
  const headerRow = lines.findIndex((l) => l.includes("Skills ·"));
  const filterRow = lines.findIndex((l) => l.includes("filter:"));
  expect(headerRow).toBeGreaterThanOrEqual(0);
  expect(filterRow).toBeGreaterThan(headerRow);
  expect(lines[headerRow]).not.toContain("filter:");

  // The splash banner must be GONE while the overlay is open (it stole the rows that caused the overflow).
  expect(frame).not.toContain("terminal coding agent");

  // BOTTOM-ANCHORED: the flightline is the LAST non-blank line — the whole stack (browser + composer +
  // flightline) is pinned to the bottom, never jammed to the top with a void below (the user's bug).
  const lastNonBlank =
    lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim().length > 0);
  expect(lines[lastNonBlank]).toContain("BUILD");
  unmount();
});

it("typing in the /skills browser filters the list", async () => {
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
      skills={skills}
      skillsInfo={{ total: skills.length, pinned: 1 }}
      onTogglePin={() => true}
    />,
  );
  await openBrowser(stdin, lastFrame);
  stdin.write("skill-11");
  await settle(60);
  const frame = lastFrame() ?? "";
  // Only the single match survives the filter — the header count reflects it (1/12) and skill-11 is shown.
  expect(frame).toContain("1/12");
  expect(frame).toContain("skill-11");
  unmount();
});
