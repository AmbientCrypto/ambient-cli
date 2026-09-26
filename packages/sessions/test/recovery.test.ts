import type { Event } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { contentHash } from "../src/objects.js";
import {
  type ToolClass,
  latestGoal,
  latestPlan,
  parsePlanTasks,
  reconcile,
  recoveryNotes,
  renderOutstandingPlan,
  unsettledTools,
} from "../src/recovery.js";

/** Minimal hand-built events (the projectors read only .kind + a few fields; full-schema validity is the
 *  writer/reader's job, tested elsewhere). */
const ev = (o: Record<string, unknown>): Event => o as unknown as Event;
const proposed = (id: string, toolName: string, args: unknown, rawArgs = "{}") =>
  ev({ kind: "tool.proposed", toolCallId: id, toolName, args, rawArgs, turnId: "trn_1" });
const started = (id: string, toolName: string) =>
  ev({ kind: "tool.started", toolCallId: id, toolName, turnId: "trn_1" });
const result = (id: string, ok = true) => ev({ kind: "tool.result", toolCallId: id, ok });

describe("latestGoal", () => {
  const goal = (text: string) => ev({ kind: "goal.set", text });
  it("returns undefined when no goal was ever set", () => {
    expect(latestGoal([proposed("t1", "plan", {})])).toBeUndefined();
  });
  it("returns the most recent goal (last goal.set wins)", () => {
    expect(latestGoal([goal("first"), proposed("t1", "plan", {}), goal("second")])).toBe("second");
  });
  it("treats an empty goal.set as a CLEAR (resolves to undefined)", () => {
    expect(latestGoal([goal("something"), goal("")])).toBeUndefined();
  });
});

describe("unsettledTools", () => {
  it("returns nothing when every started tool has a result", () => {
    expect(unsettledTools([started("t1", "write"), result("t1")])).toEqual([]);
  });
  it("flags a started tool with no result (crash / torn tail) and carries its proposed args", () => {
    const u = unsettledTools([
      proposed("t1", "write", { path: "a.txt", content: "hi" }),
      started("t1", "write"),
    ]);
    expect(u).toHaveLength(1);
    expect(u[0]?.toolName).toBe("write");
    expect((u[0]?.proposedArgs as { path?: string })?.path).toBe("a.txt");
  });
  it("returns only the unsettled ones in a mixed batch", () => {
    const u = unsettledTools([
      started("a", "read"),
      result("a"),
      started("b", "write"), // no result → unsettled
      started("c", "edit"),
      result("c"),
    ]);
    expect(u.map((x) => x.toolCallId)).toEqual(["b"]);
  });
});

describe("latestPlan", () => {
  it("is empty with no plan calls; last plan wins across updates", () => {
    expect(latestPlan([])).toEqual([]);
    const evs = [
      proposed("p1", "plan", { tasks: [{ text: "a", status: "pending" }] }),
      proposed("p2", "plan", {
        tasks: [
          { text: "a", status: "done" },
          { text: "b", status: "active" },
        ],
      }),
    ];
    expect(latestPlan(evs)).toEqual([
      { text: "a", status: "done" },
      { text: "b", status: "active" },
    ]);
  });
  it("parsePlanTasks bounds count + flattens multi-line text; rejects a non-array", () => {
    expect(parsePlanTasks({ tasks: "nope" })).toBeNull();
    const many = { tasks: Array.from({ length: 80 }, (_, i) => ({ text: `t${i}`, status: "x" })) };
    const out = parsePlanTasks(many) ?? [];
    expect(out.length).toBe(50); // ≤50
    expect(out[0]?.status).toBe("pending"); // invalid status normalized
    expect(parsePlanTasks({ tasks: [{ text: "a\nb\nc", status: "pending" }] })?.[0]?.text).toBe(
      "a b c",
    );
  });
});

describe("reconcile", () => {
  const lookup = (name: string): ToolClass | undefined =>
    ({
      read: { effects: ["read"] },
      write: { effects: ["write"], idempotency: "idempotent" },
      edit: { effects: ["write"], idempotency: "non-idempotent" },
      bash: { effects: ["process"], idempotency: "non-idempotent" },
    })[name];

  it("aborts a read-only interrupted tool (no workspace effect)", () => {
    const u = unsettledTools([started("t", "read")]);
    expect(reconcile(u, lookup)[0]?.action).toBe("abort");
  });
  it("inspects an interrupted write with the sha256 of the intended content", () => {
    const u = unsettledTools([
      proposed("t", "write", { path: "f.txt", content: "hello" }),
      started("t", "write"),
    ]);
    const r = reconcile(u, lookup)[0];
    expect(r?.action).toBe("inspect");
    expect(r?.path).toBe("f.txt");
    expect(r?.expectedPostimageHash).toBe(contentHash("hello")); // caller compares to the on-disk file
  });
  it("aborts an interrupted edit/bash (non-idempotent / opaque — never blind-replay)", () => {
    const u = unsettledTools([started("e", "edit"), started("b", "bash")]);
    const actions = reconcile(u, lookup).map((x) => x.action);
    expect(actions).toEqual(["abort", "abort"]);
  });
});

describe("recoveryNotes", () => {
  const lookup = (name: string): ToolClass | undefined =>
    ({ read: { effects: ["read"] }, write: { effects: ["write"] } })[name];

  it("says APPLIED when the injected fs check confirms the write landed, else says re-do", () => {
    const u = unsettledTools([
      proposed("t", "write", { path: "f.txt", content: "hello" }),
      started("t", "write"),
    ]);
    const rec = reconcile(u, lookup);
    expect(recoveryNotes(rec, () => true)[0]).toMatch(/already applied/);
    const redo = recoveryNotes(rec, () => false)[0];
    expect(redo).toMatch(/NOT applied/);
    expect(redo).toContain("f.txt");
  });
  it("an abort reconciliation just states the interruption (no fs check consulted)", () => {
    const u = unsettledTools([started("r", "read")]);
    const notes = recoveryNotes(reconcile(u, lookup), () => {
      throw new Error("must not consult fs for an abort");
    });
    expect(notes[0]).toMatch(/interrupted/);
  });
});

describe("renderOutstandingPlan", () => {
  it("renders pending/active tasks and is empty when all are done", () => {
    expect(renderOutstandingPlan([{ text: "a", status: "done" }])).toBe("");
    const block = renderOutstandingPlan([
      { text: "step one", status: "done" },
      { text: "step two", status: "active" },
      { text: "step three", status: "pending" },
    ]);
    expect(block).toContain("Outstanding plan");
    expect(block).toContain("step two");
    expect(block).toContain("step three");
  });
});
