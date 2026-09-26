import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { TranscriptRow } from "../src/tui/components/Transcript.js";
import type { TranscriptItem } from "../src/tui/state.js";

const note = (text: string): TranscriptItem => ({ kind: "notice", id: "n1", level: "info", text });

describe("notices", () => {
  it("print in full in scrollback, but stay capped in the live area", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const settled =
      render(<TranscriptRow item={note(long)} width={80} settled />).lastFrame() ?? "";
    expect(settled).toContain("line 40");
    const live = render(<TranscriptRow item={note(long)} width={80} />).lastFrame() ?? "";
    expect(live).not.toContain("line 40");
    expect(live).toContain("…");
  });
});

describe("the echoed prompt", () => {
  it("keeps a space after the › marker even when the prompt wraps", () => {
    const text =
      "give me a markdown list of 3 tips for writing tests, with a bold title and one example";
    const frame =
      render(<TranscriptRow item={{ kind: "user", id: "u1", text }} width={40} />).lastFrame() ??
      "";
    expect(frame).toContain("› give");
  });
});
