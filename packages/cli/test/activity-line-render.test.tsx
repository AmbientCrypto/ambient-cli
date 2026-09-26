import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ActivityLine } from "../src/tui/components/ActivityLine.js";
import { TranscriptRow } from "../src/tui/components/Transcript.js";

describe("activity line", () => {
  it("shows effort, live output and rate while thinking", () => {
    const { lastFrame } = render(
      <ActivityLine
        activity={{ verb: "Thinking" }}
        elapsed={14}
        phaseElapsed={14}
        frame={0}
        width={100}
        effort="max"
        stream={{ chars: 7_350, since: 0 }}
        now={10_000}
      />,
    );
    expect(lastFrame()).toContain("Thinking · max");
    expect(lastFrame()).toContain("↓ 2.1k tok  ·  210 tok/s");
  });
  it("drops the stats on a narrow row before the verb or clock", () => {
    const { lastFrame } = render(
      <ActivityLine
        activity={{ verb: "Thinking" }}
        elapsed={3}
        frame={0}
        width={40}
        stream={{ chars: 7_350, since: 0 }}
        now={10_000}
      />,
    );
    expect(lastFrame()).toContain("Thinking");
    expect(lastFrame()).not.toContain("tok");
  });
});

describe("thought row", () => {
  it("reads as a calm settled line", () => {
    const { lastFrame } = render(
      <TranscriptRow
        item={{ kind: "thought", id: "t1", seconds: 72.4, effort: "high" }}
        width={80}
      />,
    );
    expect(lastFrame()).toContain("∴ Thought for 1m 12s · high");
  });
});
