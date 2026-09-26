import type { NewEvent } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { contextReport, tokens, usageReport } from "../src/tui/reports.js";
import { initialState, reduce } from "../src/tui/state.js";

const base = { schemaVersion: 1 as const, sessionId: "ses_a", turnId: "trn_a", attemptId: "att_a" };
const response = (prompt: number, completion: number, cached?: number): NewEvent => ({
  ...base,
  kind: "inference.response",
  promptTokens: prompt,
  completionTokens: completion,
  ...(cached !== undefined ? { cachedTokens: cached } : {}),
  empty: false,
  truncated: false,
});

describe("session usage", () => {
  it("adds up requests, tokens sent/received and cache hits across responses", () => {
    const s = [response(9_000, 300, 8_800), response(9_500, 120)].reduce(
      (st, ev) => reduce(st, ev),
      initialState({ agentMode: "build", permission: "ask", effort: "auto", requestedModel: "m" }),
    );
    expect(s.status.usage).toEqual({
      requests: 2,
      promptTokens: 18_500,
      completionTokens: 420,
      cachedTokens: 8_800,
      lastPromptTokens: 9_500,
      lastCachedTokens: 0,
    });
    const text = usageReport(s.status.usage);
    expect(text).toContain("2 requests");
    expect(text).toContain("18.5k tokens (8.8k from cache)");
    expect(text).toContain("received   420 tokens");
    expect(text).not.toMatch(/\$|cost|price/i);
  });
  it("says so when nothing was sent yet", () => {
    expect(usageReport(undefined)).toMatch(/no requests yet/);
  });
});

describe("/context", () => {
  it("shows the window, how full it is, when it compacts, and the cache on the last request", () => {
    const text = contextReport({
      model: "glm-5.2",
      window: 202_752,
      inUse: 18_200,
      compactsAt: 170_000,
      usage: {
        requests: 1,
        promptTokens: 18_200,
        completionTokens: 10,
        cachedTokens: 17_900,
        lastPromptTokens: 18_200,
        lastCachedTokens: 17_900,
      },
    });
    expect(text).toContain("glm-5.2 · 203k window");
    expect(text).toContain("18.2k tokens (9%)");
    expect(text).toContain("about 170k");
    expect(text).toContain("17.9k from cache (98%)");
  });
  it("is honest before the first request", () => {
    expect(contextReport({})).toMatch(/nothing sent yet/);
  });
  it("formats token counts compactly", () => {
    expect([tokens(950), tokens(18_240), tokens(202_752), tokens(1_048_576)]).toEqual([
      "950",
      "18.2k",
      "203k",
      "1.0M",
    ]);
  });
});

describe("context-fill warnings", () => {
  const preflight = (used: number): NewEvent =>
    ({
      ...base,
      kind: "context.preflight",
      model: "m",
      contextWindow: 100_000,
      promptEstimate: used,
      reserve: 1_000,
      requestedOutput: 8_000,
      sentOutput: 8_000,
      remainingShared: 0,
      overflow: false,
    }) as unknown as NewEvent;
  const notices = (s: ReturnType<typeof initialState>) =>
    s.transcript.filter((t) => t.kind === "notice").map((t) => (t as { text: string }).text);
  it("says each level once, in order, and again after compaction frees room", () => {
    let s = initialState({
      agentMode: "build",
      permission: "ask",
      effort: "auto",
      requestedModel: "m",
    });
    for (const used of [50_000, 71_000, 72_000, 86_000, 96_000, 97_000])
      s = reduce(s, preflight(used));
    expect(notices(s).map((t) => t.slice(0, 12))).toEqual([
      "context 71% ",
      "context 86% ",
      "context 96% ",
    ]);
    s = reduce(s, { ...base, kind: "context.compacted", keptTokens: 30_000, summarizedPhases: 4 });
    s = reduce(s, preflight(75_000));
    expect(notices(s).at(-1)).toMatch(/^context 75% full/);
  });
});
