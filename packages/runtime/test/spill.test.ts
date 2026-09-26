import { describe, expect, it } from "vitest";
import { planSpill } from "../src/agent-support.js";
import type { Msg } from "../src/ports.js";

/**
 * Last-resort SPILL: when compaction can't shrink the transcript below a small served window, the agent
 * evicts the MIDDLE (everything between the goal anchor and the newest turn) to the artifact store rather than
 * dead-ending in "blocked". planSpill is the pure planner behind that — these lock its two load-bearing
 * properties: it never splits a tool group, and it returns null (→ honest block) when there is nothing safe
 * left to evict.
 */
describe("planSpill (last-resort context spill)", () => {
  const anchor: Msg[] = [
    { role: "system", content: "system prompt with the goal anchor" },
    // The agent pins the current task message, so eviction can never drop it.
    { role: "user", content: "the original task instruction", pinned: true },
  ];
  const groupA: Msg[] = [
    { role: "assistant", content: "calling read on a.ts", toolGroupId: "A" },
    { role: "tool", content: "contents of a.ts — the older turn", toolGroupId: "A" },
  ];
  const groupB: Msg[] = [
    { role: "assistant", content: "calling read on b.ts", toolGroupId: "B" },
    { role: "tool", content: "contents of b.ts — the newest turn", toolGroupId: "B" },
  ];

  it("evicts the middle turn(s) and keeps the goal anchor + the newest turn — never splitting a tool group", () => {
    const out = planSpill([...anchor, ...groupA, ...groupB]);
    expect(out).not.toBeNull();
    if (!out) return;
    // The system prompt leads; the pinned task is never evicted and keeps its place, before the newest turn.
    expect(out.anchor).toEqual([anchor[0]]);
    // The middle group (A) is evicted WHOLE — both the call and its result, never one without the other.
    expect(out.evictedCount).toBe(2);
    expect(out.evictedText).toContain("contents of a.ts");
    expect(out.evictedText).toContain("calling read on a.ts");
    // The newest turn (group B) is retained WHOLE as `recent`.
    expect(out.recent).toEqual([anchor[1], ...groupB]);
    // …and the newest turn is NOT in the evicted blob.
    expect(out.evictedText).not.toContain("contents of b.ts");
  });

  it("preserves a native tool-call message's payload in the evicted blob", () => {
    // A native assistant tool-call message carries content:"" with its real state in `toolCalls` — the evicted
    // blob must record the tool name + args, not an empty "assistant:" line, or the paged-back history is useless.
    const nativeCall: Msg[] = [
      {
        role: "assistant",
        content: "",
        toolGroupId: "W",
        toolCalls: [
          { id: "tc_w", name: "write", args: { path: "a.ts", content: "x" }, rawArgs: "{}" },
        ],
      },
      { role: "tool", content: "wrote a.ts", toolGroupId: "W" },
    ];
    const out = planSpill([...anchor, ...nativeCall, ...groupB]);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.evictedText).toContain("write"); // the tool name survived
    expect(out.evictedText).toContain("a.ts"); // …and its args
  });

  it("returns null when the newest turn is the only turn (nothing safe to evict → caller blocks honestly)", () => {
    // Only one tool group after the anchor: it IS the newest turn, so there is no middle to spill.
    expect(planSpill([...anchor, ...groupB])).toBeNull();
  });

  it("returns null on the anchor alone (a huge turn-1 instruction can't be relieved by eviction)", () => {
    expect(planSpill(anchor)).toBeNull();
  });

  it("evicts multiple older turns at once, keeping only the newest group", () => {
    const groupC: Msg[] = [
      { role: "assistant", content: "calling list", toolGroupId: "C" },
      { role: "tool", content: "the freshest turn output", toolGroupId: "C" },
    ];
    const out = planSpill([...anchor, ...groupA, ...groupB, ...groupC]);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.evictedCount).toBe(4); // groups A + B
    expect(out.recent).toEqual([anchor[1], ...groupC]); // the task, then only the newest group
    expect(out.evictedText).toContain("contents of a.ts");
    expect(out.evictedText).toContain("contents of b.ts");
    expect(out.evictedText).not.toContain("the freshest turn output");
  });
});
