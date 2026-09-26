import { describe, expect, it } from "vitest";
import { SUMMARY_MARKER, deterministicSummary } from "../src/agent-support.js";

/**
 * Regression guard: the model-summary message the agent writes on compaction MUST start with the SAME
 * SUMMARY_MARKER the deterministic carry-forward reader looks for — otherwise a 2nd+ compaction drops the
 * earlier summary and progressively loses state. This test locks the marker alignment.
 */
describe("summary marker carry-forward alignment", () => {
  it("carries a prior MODEL summary forward (it starts with SUMMARY_MARKER, like agent.ts writes it)", () => {
    // Exactly the shape agent.ts:compact() now emits for a model-generated summary.
    const priorModelSummary = {
      role: "system" as const,
      content: `${SUMMARY_MARKER} (another model may have written this — re-verify with your tools before relying on it)\nDECISION: use zod at boundaries. Files: a.ts, b.ts.`,
    };
    const out = deterministicSummary([
      priorModelSummary,
      { role: "user" as const, content: "now add tests" },
    ]);
    expect(out).toContain("Carried forward from earlier compaction");
    expect(out).toContain("use zod at boundaries"); // the earlier state survives a second compaction
  });

  it("does NOT carry forward a message that lacks the marker (proves the check is real)", () => {
    const out = deterministicSummary([
      { role: "system" as const, content: "## Some other heading\nunrelated text" },
      { role: "user" as const, content: "hi" },
    ]);
    expect(out).not.toContain("Carried forward from earlier compaction");
  });
});
