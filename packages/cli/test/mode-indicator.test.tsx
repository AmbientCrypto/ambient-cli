import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/tui/components/Composer.js";
import { StatusLine } from "../src/tui/components/StatusLine.js";
import type { Status } from "../src/tui/state.js";

function status(over: Partial<Status> = {}): Status {
  return {
    agentMode: "build",
    permission: "ask",
    effort: "auto",
    requestedModel: "vendor/m",
    targetModel: "vendor/m",
    running: false,
    ...over,
  } as Status;
}

// PLAN/BUILD must be unmistakable. It shows in TWO places: a bold reverse-video pill in
// the status line, and a mode label + tinted border on the composer where you type.

describe("mode indicator — PLAN vs BUILD is clear in the status line and on the composer", () => {
  it("StatusLine shows the mode as a padded pill (space-padded so reverse-video reads as a block)", () => {
    const build = render(<StatusLine status={status({ agentMode: "build" })} width={80} />);
    expect(build.lastFrame() ?? "").toContain(" BUILD ");
    build.unmount();
    const plan = render(<StatusLine status={status({ agentMode: "plan" })} width={80} />);
    expect(plan.lastFrame() ?? "").toContain(" PLAN ");
    plan.unmount();
  });

  it("Composer shows a mode label above the input, switching PLAN ↔ BUILD", () => {
    const plan = render(<Composer value="" running={false} width={80} agentMode="plan" />);
    expect(plan.lastFrame() ?? "").toContain("PLAN");
    plan.unmount();
    const build = render(<Composer value="" running={false} width={80} agentMode="build" />);
    expect(build.lastFrame() ?? "").toContain("BUILD");
    build.unmount();
  });

  it("in plan-review the composer shows ONE clear 'PLAN READY' approve/revise header (no mode pill)", () => {
    const { lastFrame, unmount } = render(
      <Composer
        value=""
        running={false}
        width={80}
        agentMode="plan"
        planReview
        planReviewSteps={3}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Plan ready · 3 steps");
    expect(frame).toContain("approve & build");
    expect(frame).toContain("revise the plan");
    expect(frame).toContain("keep planning");
    unmount();
  });
});
