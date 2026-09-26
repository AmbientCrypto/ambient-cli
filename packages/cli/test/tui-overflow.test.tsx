import { Box, Text, render } from "ink";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WaveSummary } from "../src/tui/components/WaveSummary.js";
import type { WaveState } from "../src/tui/state.js";

// The interactive overflow path CANNOT be exercised by ink-testing-library — it renders Ink in debug mode,
// which bypasses the real terminal writer. So this suite drives Ink's REAL `render` against a fake TTY stdout
// and inspects the raw escape sequences. It guards the one invariant that keeps long sessions sane:
//
//   Ink writes `\x1b[3J` (erase scrollback) whenever the dynamic frame overflows the viewport. The TUI wraps
//   its whole dynamic tree in a `maxHeight={rows-1}` + `overflowY:"hidden"` clamp so Ink measures the frame as
//   the CLAMPED height and never full-clears. This test proves the clamp actually prevents the erase (and that
//   an UNCLAMPED tree of the same content still triggers it — i.e. the test can fail).

const ROWS = 20;
const COLS = 80;
const CLEAR_SCROLLBACK = "\x1b[3J"; // the byte that erases native scrollback

function fakeTty() {
  const writes: string[] = [];
  const stdout = {
    isTTY: true,
    columns: COLS,
    rows: ROWS,
    write(s: string) {
      writes.push(String(s));
      return true;
    },
    on() {
      return stdout;
    },
    off() {
      return stdout;
    },
    once() {
      return stdout;
    },
    removeListener() {
      return stdout;
    },
    emit() {
      return false;
    },
  };
  const stdin = {
    isTTY: true,
    on() {
      return stdin;
    },
    off() {
      return stdin;
    },
    once() {
      return stdin;
    },
    removeListener() {
      return stdin;
    },
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read() {
      return null;
    },
  };
  return { writes, stdout, stdin };
}

// The exact shape the App uses: a maxHeight clamp holding a bottom-anchored, clip-its-own-top growable region
// plus a flexShrink=0 footer (composer + status) that must never be clipped.
function Clamped({ n }: { n: number }): ReactNode {
  const lines = Array.from({ length: n }, (_, i) => `line-${i + 1}`);
  return (
    <Box flexDirection="column" maxHeight={ROWS - 1} overflowY="hidden">
      <Box flexDirection="column" flexShrink={1} overflowY="hidden" justifyContent="flex-end">
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static fixture
          <Text key={i}>{l}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        <Text>COMPOSER</Text>
        <Text>STATUS</Text>
      </Box>
    </Box>
  );
}

function Unclamped({ n }: { n: number }): ReactNode {
  const lines = Array.from({ length: n }, (_, i) => `line-${i + 1}`);
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static fixture
        <Text key={i}>{l}</Text>
      ))}
      <Text>COMPOSER</Text>
    </Box>
  );
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ink only reads window size / picks the interactive path off a real TTY that isn't CI.
let savedCi: string | undefined;
beforeEach(() => {
  savedCi = process.env.CI;
  process.env.CI = undefined;
});
afterEach(() => {
  process.env.CI = savedCi;
});

describe("interactive overflow (real Ink render, fake TTY) — the clamp never erases scrollback", () => {
  it("an UNCLAMPED tree taller than the viewport DOES erase scrollback (proves the test can fail)", async () => {
    const { writes, stdout, stdin } = fakeTty();
    const { rerender, unmount } = render(<Unclamped n={ROWS * 3} />, {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake TTY streams
      stdout: stdout as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake TTY streams
      stdin: stdin as any,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    rerender(<Unclamped n={ROWS * 3} />); // a 2nd frame so a previous frame exists (the clear gate needs one)
    await settle(50);
    const frame = writes.join("");
    unmount();
    expect(frame).toContain(CLEAR_SCROLLBACK);
  });

  it("the CLAMPED tree of the same height does NOT erase scrollback, and keeps the tail + composer + status", async () => {
    const { writes, stdout, stdin } = fakeTty();
    const { rerender, unmount } = render(<Clamped n={ROWS * 3} />, {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake TTY streams
      stdout: stdout as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake TTY streams
      stdin: stdin as any,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    rerender(<Clamped n={ROWS * 3} />);
    await settle(50);
    const frame = writes.join("");
    unmount();
    expect(frame).not.toContain(CLEAR_SCROLLBACK); // no scrollback erase
    expect(frame).toContain(`line-${ROWS * 3}`); // most-recent line (the tail) stays visible
    expect(frame).not.toContain("line-1\n"); // oldest line is clipped away, not kept
    expect(frame).toContain("COMPOSER"); // the footer is never clipped
    expect(frame).toContain("STATUS");
  });

  it("stays bounded when content is SHORT — everything visible, no scrollback erase, no giant gap", async () => {
    const { writes, stdout, stdin } = fakeTty();
    const { rerender, unmount } = render(<Clamped n={3} />, {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake TTY streams
      stdout: stdout as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake TTY streams
      stdin: stdin as any,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    rerender(<Clamped n={3} />);
    await settle(50);
    const frame = writes.join("");
    unmount();
    expect(frame).not.toContain(CLEAR_SCROLLBACK);
    expect(frame).toContain("line-1"); // short content: the head is NOT clipped
    expect(frame).toContain("line-3");
    expect(frame).toContain("COMPOSER");
  });

  it("a BIG live subagent wave stays a small panel — the frame never nears fullscreen, no erase", async () => {
    // The strobe (13 stacked "subagent running" lines) came from a near-fullscreen wave frame that scrolled
    // and stranded its top line. WaveSummary is fixed-height, so even a 50-scout wave keeps the frame small.
    const wave: WaveState = {
      id: "w1",
      roleWord: "scouts",
      total: 50,
      done: 3,
      actions: Array.from({ length: 4 }, (_, i) => ({
        childSessionId: `c${i}`,
        label: `scout-${i}`,
        text: `Reading src/very/deep/path/file-${i}.ts`,
      })),
      labels: {},
      okCount: 0,
      partialCount: 0,
    };
    const { writes, stdout, stdin } = fakeTty();
    const Tree = (): ReactNode => (
      <Box flexDirection="column" maxHeight={ROWS - 1} overflowY="hidden">
        <Box flexDirection="column" flexShrink={1} overflowY="hidden" justifyContent="flex-end">
          <WaveSummary wave={wave} frame={0} elapsed={12} expanded width={COLS} />
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Text>COMPOSER</Text>
          <Text>STATUS</Text>
        </Box>
      </Box>
    );
    const { rerender, unmount } = render(<Tree />, {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake TTY streams
      stdout: stdout as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake TTY streams
      stdin: stdin as any,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    rerender(<Tree />);
    await settle(50);
    const frame = writes.join("");
    unmount();
    expect(frame).not.toContain(CLEAR_SCROLLBACK); // a big wave never triggers the scrollback erase
    // The whole dynamic frame is a handful of lines (wave panel ≤5 + footer 2), nowhere near ROWS.
    const visible = frame
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes to count visible lines
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(visible.length).toBeLessThan(ROWS - 5);
    expect(frame).toContain("50 scouts running");
    expect(frame).toContain("COMPOSER");
  });
});
