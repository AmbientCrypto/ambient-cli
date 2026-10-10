import { describe, expect, it } from "vitest";
import { type TranscriptItem, initialState } from "../src/tui/state.js";
import { acknowledgePrinted, boundPrompts, boundView } from "../src/tui/view-retention.js";
const initial = () =>
  initialState({
    agentMode: "build",
    permission: "bypass",
    effort: "auto",
    requestedModel: "auto",
  });

describe("bounded view retention", () => {
  it("drops acknowledged settled history without losing active work or resetting ids", () => {
    const transcript: TranscriptItem[] = Array.from({ length: 501 }, (_, n) => ({
      kind: "notice",
      id: `i-${n}`,
      level: "info",
      text: "done",
    }));
    const active: TranscriptItem = {
      kind: "assistant",
      id: "i-501",
      text: "working",
      streaming: true,
      spin: 0,
    };
    const state = { ...initial(), seq: 502, transcript: [...transcript, active] };
    expect(acknowledgePrinted(state, "missing")).toBe(state);
    const next = acknowledgePrinted(state, "i-500");
    expect(next.transcript).toEqual([active]);
    expect(next.seq).toBe(502);
    expect(state.transcript).toHaveLength(502);
    expect(acknowledgePrinted(state, "i-501")).toBe(state);
  });
  it("keeps small printed batches and enforces the byte budget for oversized batches", () => {
    const state = {
      ...initial(),
      transcript: [{ kind: "notice", id: "i-0", level: "info", text: "hello" }] as TranscriptItem[],
    };
    expect(acknowledgePrinted(state, "i-0")).toBe(state);
    const large = {
      ...state,
      transcript: [
        { ...state.transcript[0], text: "x".repeat(9 * 1024 * 1024) },
      ] as TranscriptItem[],
    };
    expect(acknowledgePrinted(large, "i-0").transcript).toEqual([]);
  });
  it("caps a single unbroken streaming paragraph without changing the original state", () => {
    const state = {
      ...initial(),
      transcript: [
        { kind: "assistant", id: "i-0", text: "x".repeat(100_000), streaming: true, spin: 0 },
      ] as TranscriptItem[],
    };
    const next = boundView(state);
    expect(JSON.stringify(next.transcript).length).toBeLessThan(70_000);
    expect(JSON.stringify(state.transcript).length).toBeGreaterThan(100_000);
  });
  it("caps prompt recall by count and UTF-8 bytes, retaining the newest entries", () => {
    expect(boundPrompts(Array.from({ length: 600 }, (_, n) => String(n)))).toHaveLength(500);
    expect(boundPrompts(["x".repeat(1024 * 1024), "newest"])).toEqual(["newest"]);
    expect(boundPrompts(["界".repeat(400_000)])).toEqual([]);
    expect(boundPrompts(["one", "two"])).toEqual(["one", "two"]);
  });
});
