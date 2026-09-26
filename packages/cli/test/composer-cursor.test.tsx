import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/tui/components/Composer.js";

describe("Composer — inline caret + windowed editing", () => {
  it("draws the caret INLINE at the cursor offset (edit anywhere, not just the end)", () => {
    // cursor between 'ab' and 'cd' → the ▋ sits between them, not trailing the whole value.
    const { lastFrame, unmount } = render(
      <Composer value="abcd" cursor={2} running={false} width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ab▋cd");
    unmount();
  });

  it("defaults the caret to the end when no cursor is passed (back-compat)", () => {
    const { lastFrame, unmount } = render(<Composer value="hello" running={false} width={80} />);
    expect(lastFrame() ?? "").toContain("hello▋");
    unmount();
  });

  it("windows a tall buffer around the caret with above/below markers", () => {
    const value = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
    // caret near the middle (start of L10) → both an 'above' and a 'below' marker.
    const cursor = value.indexOf("L10");
    const { lastFrame, unmount } = render(
      <Composer value={value} cursor={cursor} running={false} width={80} maxRows={6} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("more lines above");
    expect(frame).toContain("more lines below");
    expect(frame).toContain("L10"); // the caret row is inside the window
    expect(frame).not.toContain("[pasted"); // no chip
    unmount();
  });

  it("empty value shows the placeholder with a leading caret (unchanged)", () => {
    const { lastFrame, unmount } = render(<Composer value="" running={false} width={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▋");
    expect(frame).toContain("Describe a coding task");
    unmount();
  });
});
