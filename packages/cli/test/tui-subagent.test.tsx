import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WaveSummary } from "../src/tui/components/WaveSummary.js";
import type { WaveAction, WaveState } from "../src/tui/state.js";

function action(i: number): WaveAction {
  return { childSessionId: `c${i}`, label: `scout-${i}`, text: `Reading src/file-${i}.ts` };
}
function wave(total: number, actions: number): WaveState {
  return {
    id: "w1",
    roleWord: "scouts",
    total,
    done: 0,
    actions: Array.from({ length: actions }, (_, i) => action(i + 1)),
    labels: {},
    okCount: 0,
    partialCount: 0,
  };
}

describe("WaveSummary — the live wave is a small, FIXED-HEIGHT panel (never a tall re-rendering tree)", () => {
  it("collapsed: header + at most ONE action line, regardless of how many run", () => {
    const { lastFrame, unmount } = render(
      <WaveSummary wave={wave(8, 4)} frame={0} elapsed={42} width={80} />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(2); // header + one action — a big wave can't grow the panel
    expect(frame).toContain("8/8 scouts running"); // running/total from the wave
    expect(frame).toContain("0:42"); // elapsed clock
    expect(frame).toContain("view"); // the expand affordance
    unmount();
  });

  it("expanded: one line per running action, bounded (never a wall)", () => {
    const { lastFrame, unmount } = render(
      <WaveSummary wave={wave(8, 4)} frame={0} elapsed={5} expanded width={80} />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(5); // header + ≤4 action lines (the MAX_WAVE_ACTIONS ring)
    expect(frame).toContain("scout-1");
    expect(frame).toContain("collapse");
    unmount();
  });

  it("shows the done count in the header as children finish", () => {
    const { lastFrame, unmount } = render(
      <WaveSummary wave={{ ...wave(4, 2), done: 2 }} frame={0} elapsed={10} width={80} />,
    );
    expect(lastFrame() ?? "").toContain("2/4 scouts running"); // 4 total, 2 still running
    unmount();
  });
});
