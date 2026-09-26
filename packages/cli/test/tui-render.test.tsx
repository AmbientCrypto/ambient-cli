import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { FleetRow } from "../src/render/fleet.js";
import { App } from "../src/tui/App.js";
import { ActivityLine } from "../src/tui/components/ActivityLine.js";
import { Banner } from "../src/tui/components/Banner.js";
import { Composer } from "../src/tui/components/Composer.js";
import { ModelPicker } from "../src/tui/components/ModelPicker.js";
import { Plan } from "../src/tui/components/Plan.js";
import { SlashPalette, matchSlash } from "../src/tui/components/SlashPalette.js";
import { StatusLine } from "../src/tui/components/StatusLine.js";
import { Thinking } from "../src/tui/components/Thinking.js";
import { Transcript, hardWrap } from "../src/tui/components/Transcript.js";
import type { Status, TranscriptItem } from "../src/tui/state.js";

const stubClient = {
  fetchCatalog: async () => [],
  chat: async () => ({ content: "", toolCalls: [] }),
} as unknown as ChatClient;
const stubWriter = () => ({ append() {} }) as unknown as SessionWriter;
const fleet4: FleetRow[] = Array.from({ length: 4 }, (_, i) => ({
  avail: "ready" as const,
  id: `vendor/model-${i}`,
  ctx: "262k",
  lane: "direct" as const,
  vision: "vision:no",
}));

describe("tui render", () => {
  it("renders the branded idle frame: wordmark, tagline, mode, composer, status", () => {
    const { lastFrame, unmount } = render(
      <App
        client={stubClient}
        makeWriter={stubWriter}
        agentMode="build"
        permission="ask"
        effort="auto"
        requestedModel="moonshotai/kimi-k2.7-code"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
        fleet={fleet4}
      />,
    );
    const frame = lastFrame() ?? "";
    // With no launch notes the full banner and the composer fit a 24-row terminal exactly.
    expect(frame).toContain("█"); // the block "AMBIENT" wordmark
    expect(frame.toLowerCase()).toContain("terminal coding agent");
    expect(frame).toContain("4"); // live model count ("4 models on Ambient")
    expect(frame).toContain("models on Ambient");
    expect(frame).toContain("BUILD"); // agent-mode label
    expect(frame).toMatch(/BUILD\s+ask/); // double-space grouping: mode then permission (not just any "ask"/"task")
    expect(frame).toContain("Describe a coding task"); // the persistent input box
    expect(frame).toContain("ready"); // the compact status state
    unmount();
  });

  it("Transcript renders geometric status glyphs, a diff, and a substitution notice", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "u1", text: "add a function" },
      { kind: "assistant", id: "a1", text: "On it.", streaming: false, spin: 0 },
      {
        kind: "tool",
        id: "t1",
        name: "write",
        preview: "a.ts",
        status: "ok",
        durationMs: 5,
        diff: "+++ a.ts\n+export const x = 1",
      },
      {
        kind: "tool",
        id: "t2",
        name: "bash",
        preview: "$ npm test",
        status: "fail",
        durationMs: 9,
        error: "exit 1",
      },
      { kind: "handoff", id: "h1", from: "kimi", to: "glm", role: "reviewer" },
      { kind: "notice", id: "n1", level: "info", text: "compacted context" },
    ];
    const { lastFrame, unmount } = render(<Transcript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("› add a function"); // clean user marker (no letter-spaced label)
    expect(frame).toContain("✓ write"); // ok tool
    expect(frame).toContain("✗ bash"); // failed tool
    expect(frame).toContain("+export const x = 1"); // diff addition
    expect(frame).toContain("⇢ kimi → glm"); // handoff (distinct glyph from the ↪ substitution receipt)
    expect(frame).toContain("· compacted context"); // notice (clean mark, not letter-spaced)
    unmount();
  });

  it("a failed tool WRAPS its long error so the full path is readable, not truncated off the edge", () => {
    const longErr =
      "EACCES: permission denied, scandir '/Users/alice/Library/Application Support/SomeApp/Location Service/4.3.0.0/LocationCheck/crash_dumps/b1a2c3'";
    const items: TranscriptItem[] = [
      {
        kind: "tool",
        id: "t1",
        name: "glob",
        preview: "/**/tui/Composer.tsx",
        status: "fail",
        durationMs: 29841,
        error: longErr,
      },
    ];
    const { lastFrame, unmount } = render(<Transcript items={items} width={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("permission denied"); // the start of the error…
    expect(frame).toContain("crash_dumps"); // …AND the TAIL of the path — before, this was truncated off-screen
    unmount();
  });

  it("wraps assistant prose and hard-breaks an unbroken long token within the width (no overflow — defect F)", () => {
    const longToken = "x".repeat(300); // a single unbroken run, far wider than the terminal
    const items: TranscriptItem[] = [
      {
        kind: "assistant",
        id: "a",
        text: `Here is a value: ${longToken} end.`,
        streaming: false,
        spin: 0,
      },
    ];
    const width = 40;
    const { lastFrame, unmount } = render(
      <Box width={width} flexDirection="column">
        <Transcript items={items} width={width} />
      </Box>,
    );
    const frame = lastFrame() ?? "";
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    expect(frame).toContain("Here is a value"); // the prose itself survives
    unmount();
  });

  it("renders a tool RESULT preview as clean text — never a raw JSON envelope (defect A)", () => {
    const items: TranscriptItem[] = [
      {
        kind: "tool",
        id: "t",
        name: "read",
        preview: "a.ts",
        status: "ok",
        durationMs: 4,
        resultPreview: "1\texport const x = 1;\n2\texport const y = 2;",
      },
    ];
    const { lastFrame, unmount } = render(<Transcript items={items} width={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("export const x = 1;");
    expect(frame).toContain("export const y = 2;");
    expect(frame).not.toContain('{"'); // no JSON envelope leaks through
    unmount();
  });

  it("Composer shows a small multi-line paste as visible lines, not just the tail (defect B)", () => {
    const { lastFrame, unmount } = render(
      <Composer value={"first line\nsecond line\nthird line"} running={false} width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("first line"); // ALL lines visible, not only the last
    expect(frame).toContain("second line");
    expect(frame).toContain("third line");
    unmount();
  });

  it("bounds a very long SINGLE-LINE input so the composer can't grow past a few rows", () => {
    const { lastFrame, unmount } = render(
      <Composer value={"x".repeat(2000)} running={false} width={80} />,
    );
    const frame = lastFrame() ?? "";
    const rows = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(rows.length).toBeLessThanOrEqual(11); // MAX_INPUT_ROWS (6) + border + hint — bounded, no strobe
    expect(frame).toContain("…"); // the head is elided; the tail (caret) stays visible
    unmount();
  });

  it("shows a NAVIGABLE WINDOW of a large paste (the caret's tail) with an 'above' marker, bounded", () => {
    // A big paste is no longer a dead "[pasted N lines]" chip — it's an editable window around the caret. With
    // the caret defaulted to the end, the window shows the tail and marks the hidden lines above.
    const value = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const { lastFrame, unmount } = render(<Composer value={value} running={false} width={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line 30"); // the caret's tail row is visible
    expect(frame).toContain("more lines above"); // …with a marker for the windowed-away head
    expect(frame).not.toContain("[pasted 30 lines]"); // the old chip is gone — it's editable now
    const rows = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(rows.length).toBeLessThanOrEqual(10); // bounded to ~maxRows + border/markers (no strobe)
    unmount();
  });

  it("a large paste of LONG (wrapping) lines stays bounded — no unbounded wall", () => {
    // A big paste whose lines are long code must render a bounded window (the caret's
    // tail), never a wall that overflows the screen.
    const longLine =
      "const PLAN_PREAMBLE = `You are amb, a terminal coding agent running entirely on the Ambient network`;";
    const value = Array.from({ length: 30 }, () => longLine).join("\n");
    const { lastFrame, unmount } = render(<Composer value={value} running={false} width={80} />);
    const frame = lastFrame() ?? "";
    const rows = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(rows.length).toBeLessThanOrEqual(10); // bounded — a window, never a wall (no strobe)
    expect(frame).toContain("more lines above"); // the head is windowed away, marked
    unmount();
  });

  it("EXPANDS a large paste into the available height when there's room", () => {
    // A fresh screen has ~20 free rows below; the App raises maxRows so the window grows into it (showing the
    // caret's tail deep into the paste) instead of a one-line chip.
    const value = Array.from({ length: 50 }, (_, i) => `content line ${i + 1}`).join("\n");
    const { lastFrame, unmount } = render(
      <Composer value={value} running={false} width={80} maxRows={20} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("content line 50"); // the caret's tail is shown…
    expect(frame).toContain("content line 35"); // …many rows of it — genuinely expanded, not a one-line chip
    expect(frame).toContain("more lines above"); // …with the windowed-away head marked
    const rows = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(rows.length).toBeLessThanOrEqual(24); // still bounded to ~maxRows (+ border/hint) — no strobe
    unmount();
  });

  it("a multi-line paste that FITS the budget shows in FULL — the box just grows, no chip", () => {
    const value = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join("\n");
    const { lastFrame, unmount } = render(
      <Composer value={value} running={false} width={80} maxRows={20} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("row 1");
    expect(frame).toContain("row 12"); // all 12 lines visible…
    expect(frame).not.toContain("[pasted"); // …and no chip/marker at all when it fits
    unmount();
  });

  it("caps a STREAMING answer to its recent lines but shows a SETTLED one in full", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const streaming = render(
      <Transcript
        items={[{ kind: "assistant", id: "a", text, streaming: true, spin: 0 }]}
        width={80}
      />,
    );
    const sFrame = streaming.lastFrame() ?? "";
    const sLines = sFrame.split("\n").filter((l) => l.trim().length > 0);
    expect(sLines.length).toBeLessThanOrEqual(16); // STREAM_MAX_LINES (14) + a little chrome — bounded
    expect(sFrame).toContain("line 40"); // the most recent line is visible
    expect(sFrame).not.toContain("line 5"); // an old line is capped off (bounds the live region height)
    streaming.unmount();

    const settled = render(
      <Transcript
        items={[{ kind: "assistant", id: "a", text, streaming: false, spin: 0 }]}
        width={80}
      />,
    );
    const dLines = (settled.lastFrame() ?? "").split("\n").filter((l) => l.trim().length > 0);
    expect(dLines.length).toBeGreaterThanOrEqual(40); // finalized → the FULL text (commits to scrollback)
    settled.unmount();
  });

  it("caps a STREAMING answer to the ROWS-RELATIVE maxStreamLines (so panels+stream can't overflow -> CSI-3J)", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    // On a short terminal (or with panels up) the App passes a small maxStreamLines; the streamed preview must
    // shrink to it so the live region stays under the viewport height (Ink 7 still erases scrollback on overflow).
    const { lastFrame, unmount } = render(
      <Transcript
        items={[{ kind: "assistant", id: "a", text, streaming: true, spin: 0 }]}
        width={80}
        maxStreamLines={5}
      />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(7); // ~5 streamed lines + the elision/spinner chrome
    expect(frame).toContain("line 40"); // the most recent line stays visible
    expect(frame).not.toContain("line 30"); // …older lines are trimmed to keep the region bounded
    unmount();
  });

  it("hardWrap never splits a surrogate pair (emoji) into lone surrogates", () => {
    const out = hardWrap("🔥".repeat(10), 8); // 10 code points > 8 → forced break
    // content preserved (no garbled �), and the break landed on a code-point boundary
    expect([...out].filter((c) => c !== "\n").join("")).toBe("🔥".repeat(10));
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
    expect(out.split("\n").length).toBe(2); // 8 + 2
  });

  it("echoes a multi-line paste as a [pasted N lines] summary, never a blank › (defect B)", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "u", text: "\nfirst line of paste\nsecond\nthird" },
    ];
    const { lastFrame, unmount } = render(<Transcript items={items} width={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[pasted 4 lines]");
    expect(frame).toContain("first line of paste"); // previews the first NON-empty line
    unmount();
  });

  it("Transcript renders a subagent-line (the durable scrollback record you scroll up to read)", () => {
    const items: TranscriptItem[] = [
      {
        kind: "subagent-line",
        id: "l1",
        variant: "child",
        roleWord: "scouts",
        label: "ws-path",
        childStatus: "ok",
        turns: 6,
        durationMs: 38000,
        summary: "ws upgrade bypasses the limiter",
      },
      {
        kind: "subagent-line",
        id: "l2",
        variant: "done",
        roleWord: "scouts",
        count: 2,
        okCount: 1,
        failCount: 1,
      },
    ];
    const { lastFrame, unmount } = render(<Transcript items={items} width={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓"); // finished-ok glyph
    expect(frame).toContain("ws-path"); // the scout's label
    expect(frame).toContain("6 turns");
    expect(frame).toContain("ws upgrade bypasses the limiter"); // its summary is readable in scrollback
    expect(frame).toContain("2 scouts finished");
    expect(frame).toContain("1 failed"); // the closing tally
    unmount();
    const one = render(
      <Transcript
        items={[
          {
            kind: "subagent-line",
            id: "l3",
            variant: "done",
            roleWord: "scouts",
            count: 1,
            okCount: 1,
            failCount: 0,
          },
        ]}
        width={80}
      />,
    );
    expect(one.lastFrame()).toContain("1 scout finished");
    one.unmount();
  });

  it("flightline: mode, the served model (with ← when substituted), lane, a context gauge, and state", () => {
    const status: Status = {
      agentMode: "build",
      permission: "accept-edits",
      effort: "high",
      requestedModel: "z-ai/glm-5.2",
      targetModel: "moonshotai/kimi-k2.7-code",
      lane: "assisted",
      contextWindow: 128000,
      promptEstimate: 64000,
      running: true,
    };
    const { lastFrame, unmount } = render(<StatusLine status={status} width={120} active={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("BUILD"); // agent mode
    expect(frame).toContain("accept-edits"); // permission
    expect(frame).toContain("effort high"); // reasoning effort, next to the model (user ask)
    expect(frame).toContain("●"); // served dot
    expect(frame).toContain("kimi-k2.7-code"); // SHORT served model (vendor prefix dropped)
    expect(frame).not.toContain("moonshotai/");
    expect(frame).toContain("←glm-5.2"); // requested, when substituted — never silent
    expect(frame).toContain("assisted"); // lane
    expect(frame).toContain("ctx"); // context gauge label
    expect(frame).toContain("50%"); // 64k/128k
    expect(frame).toMatch(/[█░]/); // the smooth gauge graphic
    expect(frame).toContain("working"); // state
    // the noisy metrics are intentionally NOT on the flightline
    expect(frame).not.toContain("12.4k");
    expect(frame).not.toContain("tools");
    unmount();
  });

  it("flightline shows the REPORTED serving model and never draws an empty gauge at low context", () => {
    const status: Status = {
      agentMode: "build",
      permission: "ask",
      effort: "auto",
      requestedModel: "z-ai/glm-5.2",
      targetModel: "moonshotai/kimi-k2.7-code",
      reportedModel: "deepseek/deepseek-v4-flash-0731",
      lane: "direct",
      contextWindow: 128000,
      promptEstimate: 9900, // ~7.7% — must still draw at least a partial block, never empty
      running: true,
    };
    const { lastFrame, unmount } = render(<StatusLine status={status} width={100} active={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deepseek-v4-flash-0731"); // who is ACTUALLY serving (reported), not the target
    expect(frame).not.toContain("kimi-k2.7-code"); // the resolved target is superseded by the report
    expect(frame).toContain("←glm-5.2"); // still shows what you asked for
    expect(frame).toMatch(/[█▏▎▍▌▋▊▉]/); // a low % still draws a (partial) block, not an empty gauge
    unmount();
  });

  it("StatusLine keeps the run state visible and never overflows, even with a very long model name", () => {
    const status: Status = {
      agentMode: "build",
      permission: "ask",
      effort: "auto",
      requestedModel:
        "some-vendor/an-absurdly-long-model-identifier-that-would-overflow-the-row-easily",
      lane: "assisted",
      contextWindow: 128000,
      promptEstimate: 40000,
      running: true,
    };
    const { lastFrame, unmount } = render(<StatusLine status={status} width={50} active={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("working"); // the tail (state) is preserved, not clipped off
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(50);
    unmount();
  });

  it("at 80 cols the ctx% AND run state survive — effort/lane clip first, never the context (user priority)", () => {
    const status: Status = {
      agentMode: "build",
      permission: "accept-edits", // a longer permission label — worst case for the head
      effort: "auto",
      requestedModel: "moonshotai/kimi-k2.7-code",
      lane: "direct",
      contextWindow: 128000,
      promptEstimate: 96000, // 75% — a specific, checkable percentage
      running: true,
    };
    const { lastFrame, unmount } = render(<StatusLine status={status} width={80} active={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("75%"); // the context % is pinned in the tail — must NOT be clipped to "…"
    expect(frame).toContain("working"); // run state is pinned too
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    unmount();
  });

  it("Plan renders a checklist with done/active/pending glyphs and a progress count", () => {
    const { lastFrame, unmount } = render(
      <Plan
        tasks={[
          { text: "read the auth flow", status: "done" },
          { text: "fix the expiry check", status: "active" },
          { text: "re-run the suite", status: "pending" },
        ]}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Plan  1/3"); // progress count
    expect(frame).toContain("1. ✓ read the auth flow"); // numbered "phase 1" + done glyph
    expect(frame).toContain("2. ◐ fix the expiry check"); // active (in progress)
    expect(frame).toContain("3. ○ re-run the suite"); // pending
    unmount();
  });

  it("Plan renders nothing when there are no tasks (honest empty state)", () => {
    const { lastFrame, unmount } = render(<Plan tasks={[]} />);
    expect((lastFrame() ?? "").trim()).toBe("");
    unmount();
  });

  it("Banner degrades to the compact single-line lockup on a narrow terminal", () => {
    const { lastFrame, unmount } = render(<Banner width={40} fleet={{ ready: 4 }} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("AMBIENT"); // compact lockup keeps the literal wordmark
    expect(frame).not.toContain("█"); // no block banner when narrow
    unmount();
  });

  it("ActivityLine shows the current action + detail + an elapsed clock (and nothing when idle)", () => {
    const idle = render(<ActivityLine elapsed={0} frame={0} />);
    expect((idle.lastFrame() ?? "").trim()).toBe(""); // no activity → nothing
    idle.unmount();

    const { lastFrame, unmount } = render(
      <ActivityLine
        activity={{ verb: "Editing", detail: "src/router.ts" }}
        elapsed={67}
        frame={1}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Editing");
    expect(frame).toContain("src/router.ts");
    expect(frame).toContain("1:07"); // 67s → m:ss
    unmount();
  });

  it("ActivityLine shows the PHASE clock next to the verb and the run total after it", () => {
    const { lastFrame, unmount } = render(
      <ActivityLine activity={{ verb: "Thinking" }} elapsed={105} phaseElapsed={12} frame={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking");
    expect(frame).toContain("0:12"); // this phase (thinking FOR 12s)
    expect(frame).toContain("run 1:45"); // the whole run (105s)
    unmount();
  });

  it("ActivityLine shows the reasoning EFFORT next to Thinking", () => {
    const { lastFrame, unmount } = render(
      <ActivityLine
        activity={{ verb: "Thinking" }}
        elapsed={12}
        phaseElapsed={12}
        frame={0}
        width={90}
        effort="high"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking · high"); // the effort behind the thinking
    unmount();
  });

  it("ActivityLine effort rides only on Thinking, not on a tool verb", () => {
    const frame =
      render(
        <ActivityLine
          activity={{ verb: "Reading", detail: "a.ts" }}
          elapsed={3}
          frame={0}
          width={90}
          effort="high"
        />,
      ).lastFrame() ?? "";
    expect(frame).toContain("Reading");
    expect(frame).not.toContain("Reading · high"); // effort is a thinking readout, not a tool one
  });

  it("StatusLine shows a cumulative token readout when tokens have been used", () => {
    const status: Status = {
      agentMode: "build",
      permission: "ask",
      effort: "auto",
      requestedModel: "z-ai/glm-5.2",
      running: true,
      tokensUsed: 4200,
    };
    const frame =
      render(<StatusLine status={status} width={120} active={true} />).lastFrame() ?? "";
    expect(frame).toContain("4.2k tok");
  });

  it("renders a large, mixed transcript at extreme widths without crashing or overflowing (stress)", () => {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < 120; i++) {
      items.push({ kind: "user", id: `u${i}`, text: `question ${i} `.repeat(8) });
      items.push({
        kind: "assistant",
        id: `a${i}`,
        text: `${"x".repeat(200)} answer ${i}`, // a long unbroken token + prose
        streaming: false,
        spin: 0,
      });
      items.push({
        kind: "tool",
        id: `t${i}`,
        name: "read",
        preview: `file-${i}.ts`,
        status: "ok",
        durationMs: 5,
        resultPreview: Array.from({ length: 30 }, (_, k) => `line ${k}`).join("\n"),
      });
    }
    for (const w of [1, 2, 20, 80, 300]) {
      const { lastFrame, unmount } = render(<Transcript items={items} width={w} />);
      const frame = lastFrame() ?? "";
      expect(typeof frame).toBe("string"); // rendered without throwing at any width
      // At REALISTIC widths, no line runs past the interior (hardWrap/clip hold). Below ~8 cols (no real
      // terminal) hardWrap floors its chunk at 8, so we only assert no-crash there.
      if (w >= 20) {
        for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(w);
      }
      unmount();
    }
  });

  it("SlashPalette lists the matching commands with the selected one highlighted", () => {
    const matches = matchSlash("/mod"); // → /model (a SINGLE model command, not /model + /models)
    expect(matches.map((c) => c.name)).toEqual(["/model"]);
    const { lastFrame, unmount } = render(
      <SlashPalette commands={matches} selected={0} width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/model");
    expect(frame).toContain("Switch model"); // the description is shown
    expect(frame).toContain("▸"); // selection carried by a cursor GLYPH, not color alone (NO_COLOR-safe)
    expect(frame).toContain("Commands"); // the header, consistent with the other pickers
    unmount();
  });

  it("ActivityLine truncates a long detail (never wraps) and no longer carries a keybinding", () => {
    const { lastFrame, unmount } = render(
      <ActivityLine
        activity={{ verb: "Editing", detail: "/a/very/deeply/nested/path/".repeat(6) }}
        elapsed={12}
        frame={0}
        width={60}
      />,
    );
    const frame = lastFrame() ?? "";
    const rows = frame.split("\n").filter((l) => l.trim().length > 0);
    // The inline spinning globe + status stay on ONE row — the long detail truncated, it did NOT wrap.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.length ?? 0).toBeLessThanOrEqual(60); // within the width bound (globe + text)
    expect(frame).toContain("…"); // …with a truncation ellipsis (proves it clipped, not just fit)
    expect(frame).toContain("Editing"); // the verb (fixed furniture) survives
    expect(frame).toContain("0:12"); // …and the clock is never clipped before the path
    expect(frame).not.toContain("esc to interrupt"); // the keybinding lives in the composer hint now
    unmount();
  });

  it("StatusLine shows a `think` marker exactly when the live-reasoning view is ON (toggle visibility)", () => {
    const base: Status = {
      agentMode: "build",
      permission: "ask",
      effort: "auto",
      requestedModel: "z-ai/glm-5.2",
      running: false,
    };
    const on =
      render(<StatusLine status={base} width={90} showThinking={true} />).lastFrame() ?? "";
    const off =
      render(<StatusLine status={base} width={90} showThinking={false} />).lastFrame() ?? "";
    expect(on).toContain("think"); // ON → the flightline surfaces the state
    expect(off).not.toContain("think"); // OFF → no marker
  });

  it("ActivityLine keeps the phase clock on a narrow row — the long verb truncates, the clock does not", () => {
    // The longest real verb ("Fixing failed verification") at width 36: the verb must give way, not the clock.
    const { lastFrame, unmount } = render(
      <ActivityLine
        activity={{ verb: "Fixing failed verification" }}
        elapsed={105}
        phaseElapsed={12}
        frame={0}
        width={36}
      />,
    );
    const frame = lastFrame() ?? "";
    const rows = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(rows).toHaveLength(1); // one row — the verb truncated instead of overflowing/wrapping
    expect(rows[0]?.length ?? 0).toBeLessThanOrEqual(36);
    expect(frame).toContain("0:12"); // the phase clock is the priority readout — it survives the squeeze
    expect(frame).toContain("…"); // …and the verb clipped (proof the truncate actually fires now)
    unmount();
  });

  it("Transcript keeps a failed-tool header on one row on a narrow terminal — drops the preview, never splits the exit suffix", () => {
    const items: TranscriptItem[] = [
      {
        kind: "tool",
        id: "t",
        name: "bash",
        preview: "$ npm run an-extremely-long-command",
        status: "fail",
        durationMs: 1000,
        exitCode: 1,
      },
    ];
    // Bound the column to a narrow terminal (as App does) so a wrap would actually manifest.
    const { lastFrame, unmount } = render(
      <Box width={25} flexDirection="column">
        <Transcript items={items} width={25} />
      </Box>,
    );
    const frame = lastFrame() ?? "";
    const rows = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(rows).toHaveLength(1); // one row — the preview is dropped, so nothing wraps the header
    expect(frame).toContain("exit 1"); // the priority suffix stays intact (never split across two rows)
    expect(frame).not.toContain("npm run"); // the preview was DROPPED (no room), not floored + overflowed
    unmount();
  });

  it("Banner uses a content-aware breakpoint — the wide wordmark never renders when it wouldn't fit", () => {
    // At width 60 (between the old magic 56 and the true lockup width ~59+padding) the OLD code drew the wide
    // block art and Ink shattered it; the fixed breakpoint falls back to the compact lockup instead.
    const frame = render(<Banner width={60} fleet={{ ready: 4 }} />).lastFrame() ?? "";
    expect(frame).toContain("AMBIENT"); // the compact lockup keeps the literal wordmark
    expect(frame).not.toContain("█"); // …and never the wide block art at a width that can't hold it
  });

  it("ModelPicker lists the fleet with a selection marker, ready dots, and the current model", () => {
    const rows: FleetRow[] = [
      {
        avail: "ready",
        id: "moonshotai/kimi-k2.7-code",
        ctx: "262k",
        lane: "direct",
        vision: "vision:yes",
      },
      {
        avail: "cold",
        id: "qwen/qwen3.6-27b",
        ctx: "33k",
        lane: "assisted",
        vision: "vision:no",
      },
    ];
    const { lastFrame, unmount } = render(
      <ModelPicker rows={rows} selected={0} current="moonshotai/kimi-k2.7-code" width={92} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("moonshotai/kimi-k2.7-code");
    expect(frame).toContain("qwen/qwen3.6-27b");
    expect(frame).toContain("▸"); // selection marker on the first (selected) row
    expect(frame).toContain("current"); // the current model is marked
    expect(frame).not.toContain("flagged"); // readiness is only a hint — no labels from it
    expect(frame).toContain("↑/↓"); // the hint
    // The lane column lines up as a grid: the fixed-width status column keeps `direct`/`assisted` at the
    // SAME x on the ready row (blank status) and the cold row (`· cold`) — no ragged, status-shifted columns.
    const lines = frame.split("\n");
    const readyRow = lines.find((l) => l.includes("kimi-k2.7-code")) ?? "";
    const coldRow = lines.find((l) => l.includes("qwen3.6-27b")) ?? "";
    expect(readyRow.indexOf("direct")).toBe(coldRow.indexOf("assisted"));
    unmount();
  });

  it("Thinking renders the reasoning tail when on, and nothing when off/empty", () => {
    const on = render(<Thinking text={"weighing the two approaches"} show={true} width={80} />);
    expect(on.lastFrame()).toContain("Thinking");
    expect(on.lastFrame()).toContain("weighing the two approaches");
    const off = render(<Thinking text={"secret reasoning"} show={false} width={80} />);
    expect(off.lastFrame()).not.toContain("secret reasoning"); // toggled off → hidden
    const empty = render(<Thinking text={"   "} show={true} width={80} />);
    expect((empty.lastFrame() ?? "").trim()).toBe("");
  });

  it("matchSlash returns nothing without a leading slash, and the full set for a bare '/'", () => {
    expect(matchSlash("hello")).toEqual([]);
    expect(matchSlash("/").length).toBeGreaterThanOrEqual(8);
    expect(matchSlash("/plan").map((c) => c.name)).toEqual(["/plan"]);
    expect(matchSlash("/tools").map((c) => c.name)).toEqual(["/tools"]); // tool-visibility command (I)
  });

  it("matchSlash merges discovered (Claude/Codex) commands into the palette", () => {
    const extra = [{ name: "/deploy", desc: "ship it" }];
    expect(matchSlash("/dep", extra).map((c) => c.name)).toEqual(["/deploy"]);
    // builtins still match alongside the custom ones
    expect(matchSlash("/", extra).map((c) => c.name)).toContain("/deploy");
    expect(matchSlash("/", extra).map((c) => c.name)).toContain("/help");
  });

  it("matchSlash surfaces an EXACT match first and de-dupes names", () => {
    // `/deployment` ordered before `/deploy`: typing exact `/deploy` must select `/deploy`, not `/deployment`.
    const extra = [
      { name: "/deployment", desc: "the long one" },
      { name: "/deploy", desc: "the exact one" },
    ];
    expect(matchSlash("/deploy", extra)[0]?.name).toBe("/deploy");
    // a duplicate custom `/help` can't shadow/duplicate the builtin
    const withDupHelp = matchSlash("/help", [{ name: "/help", desc: "dup" }]);
    expect(withDupHelp.filter((c) => c.name === "/help")).toHaveLength(1);
  });
});

describe("splash readiness line", () => {
  it("counts every model Ambient offers — readiness is only a hint, never a false 'none ready'", async () => {
    const { readyLine } = await import("../src/tui/components/Banner.js");
    expect(readyLine({ ready: 0, total: 4 })).toEqual({ count: "4", rest: " models on Ambient" });
    expect(readyLine({ ready: 2, total: 4 })).toEqual({ count: "4", rest: " models on Ambient" });
    expect(readyLine({ ready: 0, total: 1 }).rest).toBe(" model on Ambient");
    expect(readyLine({ ready: 0, total: 0 }).rest).toBe("no models available");
  });
});

describe("notices", () => {
  it("never double the warning glyph and keep multi-line text (e.g. /help, verify diagnostics)", () => {
    const { lastFrame, unmount } = render(
      <Transcript
        items={[
          {
            kind: "notice",
            id: "a",
            level: "warn",
            text: "⚠ Reached the turn limit — type continue.",
          },
          { kind: "notice", id: "b", level: "info", text: "line one\nline two\nline three" },
        ]}
        width={60}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("⚠ ⚠");
    expect(frame).toContain("⚠ Reached the turn limit");
    expect(frame).toContain("line one");
    expect(frame).toContain("line three");
    expect(frame.split("\n").some((l) => l.includes("line two") && !l.includes("line one"))).toBe(
      true,
    );
    unmount();
  });
});
