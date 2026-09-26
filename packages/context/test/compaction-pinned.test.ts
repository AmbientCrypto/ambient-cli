import { describe, expect, it } from "vitest";
import { planCompaction } from "../src/index.js";

const big = (role: string, tag: string, extra: Record<string, unknown> = {}) => ({
  role,
  content: `${tag} ${"x".repeat(4000)}`,
  ...extra,
});

describe("planCompaction with a pinned task message", () => {
  it("never summarizes the pinned CURRENT task, even when older messages precede it", () => {
    const msgs = [
      { role: "system", content: "sys" },
      big("user", "OLD-TASK"),
      big("assistant", "old answer"),
      big("user", "CURRENT-TASK", { pinned: true }),
      big("assistant", "step 1"),
      big("assistant", "step 2"),
      big("assistant", "step 3"),
    ];
    const plan = planCompaction(msgs, { anchorCount: 1, keepRecentTokens: 1500, reserveTokens: 0 });
    const summarized = plan.toSummarize.map((m) => String(m.content).slice(0, 12));
    expect(summarized).toContain("OLD-TASK xxx");
    expect(summarized.some((s) => s.startsWith("CURRENT-TASK"))).toBe(false);
    expect(plan.anchor.map((m) => String(m.content).slice(0, 12))).toEqual(["sys"]);
    expect(plan.kept[0]).toBe(msgs[0]);
    expect(plan.kept[1]).toBe(msgs[3]);
    // Everything kept stays in the order it happened.
    const idx = plan.kept.map((m) => msgs.indexOf(m));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("a new request in a long chat stays the LAST message, so the model answers it (not the previous one)", () => {
    const msgs = [
      { role: "system", content: "sys" },
      big("user", "essay 1 please"),
      big("assistant", "ESSAY ONE"),
      big("user", "essay 2 please"),
      big("assistant", "ESSAY TWO"),
      { role: "user", content: "NEW-REQUEST: essay 3", pinned: true },
    ];
    const plan = planCompaction(msgs, { anchorCount: 1, keepRecentTokens: 1500, reserveTokens: 0 });
    expect(plan.kept.at(-1)).toBe(msgs[5]);
    expect(plan.toSummarize).not.toContain(msgs[5]);
  });
});
