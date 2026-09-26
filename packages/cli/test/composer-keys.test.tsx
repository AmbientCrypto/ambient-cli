import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient } from "@amb/runtime";
import { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";

// Drive the REAL useInput handler (arrow/edit keys go through App, not just the Composer) and assert the
// buffer via the inline caret in the rendered frame — the machine check for arrow-nav + edit-at-caret.

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

const ESC = "\x1b";
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;
const HOME = `${ESC}[H`;
const END = `${ESC}[F`;
const BACKSPACE = "\x7f";
const FDEL = `${ESC}[3~`;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "amb-keys-"));
  process.env.AMB_HOME = home;
});
afterEach(() => {
  process.env.AMB_HOME = undefined;
  rmSync(home, { recursive: true, force: true });
});

function mount() {
  const chat: ChatClient["chat"] = async () => ({ content: "ok", toolCalls: [] });
  const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;
  return render(
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
}

async function typeSeq(stdin: { write: (s: string) => void }, seq: string[]): Promise<void> {
  for (const s of seq) {
    stdin.write(s);
    await settle(8);
  }
}

describe("composer editing — arrow-nav + edit at the caret (real key handler)", () => {
  it("inserts at the caret after moving Left, not at the end", async () => {
    const { lastFrame, stdin, unmount } = mount();
    await settle(40);
    await typeSeq(stdin, [..."abc", LEFT, LEFT, "X"]);
    // 'abc', caret at end → Left×2 → caret between a and b → type X → 'aXbc', caret after X.
    expect(lastFrame() ?? "").toContain("aX▋bc");
    unmount();
  });

  it("backspace deletes the char BEFORE the moved caret (not the last char)", async () => {
    const { lastFrame, stdin, unmount } = mount();
    await settle(40);
    await typeSeq(stdin, [..."abcd", LEFT, BACKSPACE]);
    // 'abcd', Left → caret between c and d → Backspace removes c → 'abd', caret before d.
    expect(lastFrame() ?? "").toContain("ab▋d");
    unmount();
  });

  it("forward-delete removes the char AT the caret", async () => {
    const { lastFrame, stdin, unmount } = mount();
    await settle(40);
    await typeSeq(stdin, [..."abc", HOME, FDEL]);
    // Home → caret at start → Fn+Delete removes 'a' → 'bc', caret at start.
    expect(lastFrame() ?? "").toContain("▋bc");
    unmount();
  });

  it("Home/End jump to the row bounds; typing lands there", async () => {
    const { lastFrame, stdin, unmount } = mount();
    await settle(40);
    await typeSeq(stdin, [..."mid", HOME, "S", END, "E"]);
    // 'mid' → Home → type S → 'Smid' → End → type E → 'SmidE'.
    expect(lastFrame() ?? "").toContain("SmidE▋");
    unmount();
  });

  it("Right moves the caret forward toward the end", async () => {
    const { lastFrame, stdin, unmount } = mount();
    await settle(40);
    await typeSeq(stdin, [..."abc", HOME, RIGHT, "X"]);
    // Home → caret at 0 → Right → caret between a and b → type X → 'aXbc'.
    expect(lastFrame() ?? "").toContain("aX▋bc");
    unmount();
  });
});
