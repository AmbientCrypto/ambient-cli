import type { NewEvent } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import {
  MAX_GOAL_CHARS,
  type TranscriptItem,
  appendNotice,
  clearTranscript,
  initialState,
  isSettled,
  nextPermission,
  optimisticEcho,
  reduce,
  setGoal,
  setRequestedModel,
  splitCommittable,
  toRuntimeMode,
  toggleAgentMode,
  withStop,
} from "../src/tui/state.js";

const base = { schemaVersion: 1 as const, sessionId: "ses_a", turnId: "trn_a", attemptId: "att_a" };
const init = () =>
  initialState({
    agentMode: "build",
    permission: "ask",
    effort: "auto",
    requestedModel: "moonshotai/kimi-k2.7-code",
  });

describe("setGoal + goal persistence across a run", () => {
  it("sets a trimmed goal and clears on empty", () => {
    const withGoal = setGoal(init(), "  ship the export  ");
    expect(withGoal.goal).toBe("ship the export");
    expect(setGoal(withGoal, "   ").goal).toBeUndefined(); // empty → cleared
  });

  it("caps an over-long goal to MAX_GOAL_CHARS", () => {
    const long = "x".repeat(MAX_GOAL_CHARS + 50);
    expect(setGoal(init(), long).goal?.length).toBe(MAX_GOAL_CHARS);
  });

  it("PRESERVES the goal across session.started (unlike the plan, which resets)", () => {
    const s = reduce(setGoal(init(), "the north star"), {
      kind: "session.started",
      ...base,
      cwd: "/w",
      workspaceRoot: "/w",
    } as NewEvent);
    expect(s.goal).toBe("the north star"); // north-star survives a new run
    expect(s.plan).toEqual([]); // plan is reset
  });
});

describe("tui reducer — handoff", () => {
  const resolved = (id: string) =>
    ({
      kind: "model.resolved",
      ...base,
      requestedModel: id,
      targetModel: id,
      lane: "direct",
      rule: "exact-live",
    }) as NewEvent;
  it("a compactor (utility) handoff does NOT repoint the flightline; a failover handoff DOES", () => {
    let s = reduce(init(), resolved("vendor/main"));
    s = reduce(s, {
      kind: "handoff",
      ...base,
      from: "vendor/main",
      to: "cheap/flash",
      role: "compactor",
    } as NewEvent);
    expect(s.status.targetModel).toBe("vendor/main"); // compaction is a side call, not a serving switch
    s = reduce(s, {
      kind: "handoff",
      ...base,
      from: "vendor/main",
      to: "other/model",
      role: "executor",
    } as NewEvent);
    expect(s.status.targetModel).toBe("other/model"); // a real failover repoints
  });
});

describe("tui reducer — model.resolved receipt", () => {
  const resolved = (requestedModel: string, targetModel: string) =>
    ({
      kind: "model.resolved",
      ...base,
      requestedModel,
      targetModel,
      lane: "direct",
      rule: requestedModel === "auto" ? "auto-best" : "ready-substitution",
      reason: requestedModel === "auto" ? "no model requested; picked the best" : "cold",
    }) as NewEvent;

  it("an `auto` pick emits NO receipt (it's the default, not a substitution — flightline shows ←auto)", () => {
    const s = reduce(init(), resolved("auto", "moonshotai/kimi-k2.7-code"));
    expect(s.transcript.filter((t) => t.kind === "receipt")).toHaveLength(0);
    expect(s.status.targetModel).toBe("moonshotai/kimi-k2.7-code"); // status still updates
  });

  it("an explicit cold model DOES emit a substitution receipt", () => {
    const s = reduce(init(), resolved("acme/legacy", "z-ai/glm-5.2"));
    const receipts = s.transcript.filter((t) => t.kind === "receipt");
    expect(receipts).toHaveLength(1);
    // the receipt uses the short (vendor-stripped) name
    expect((receipts[0] as { text: string }).text).toMatch(/you asked for (\S+\/)?legacy/);
  });
});

describe("tui reducer — thinking", () => {
  it("accumulates reasoning.delta into a bounded transient buffer and shows it by default", () => {
    let s = init();
    expect(s.showThinking).toBe(true);
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "Let me " } as NewEvent);
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "think about it." } as NewEvent);
    expect(s.thinking).toBe("Let me think about it.");
  });
  it("clears the reasoning tail when the model starts ANSWERING (assistant.delta)", () => {
    let s = init();
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "reasoning…" } as NewEvent);
    s = reduce(s, { kind: "assistant.delta", ...base, text: "Here is the answer." } as NewEvent);
    expect(s.thinking).toBe("");
  });
  it("clears the reasoning tail when the model starts ACTING (tool.started)", () => {
    let s = init();
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "planning a read" } as NewEvent);
    s = reduce(s, {
      kind: "tool.started",
      ...base,
      toolCallId: "tc_1",
      toolName: "read",
    } as NewEvent);
    expect(s.thinking).toBe("");
  });
  it("bounds the buffer to a rolling tail (a verbose model can't grow it unbounded)", () => {
    let s = init();
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "x".repeat(10_000) } as NewEvent);
    expect(s.thinking.length).toBeLessThanOrEqual(4000);
  });
});

describe("tui reducer", () => {
  it("turn.started marks running and pushes the user input", () => {
    const s = reduce(init(), {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "add a test",
    } as NewEvent);
    expect(s.status.running).toBe(true);
    expect(s.transcript).toEqual([{ kind: "user", id: expect.any(String), text: "add a test" }]);
  });

  it("optimistic echo shows the message + Thinking instantly; turn.started confirms it in place (no dup)", () => {
    // The instant the user submits: echo the message + go "Thinking" (before the run's catalog fetch).
    let s = optimisticEcho(init(), "add a test");
    expect(s.status.running).toBe(true);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
    expect(s.transcript).toEqual([
      { kind: "user", id: expect.any(String), text: "add a test", optimistic: true },
    ]);

    // session.started (run begins) must NOT clear the activity — else "Thinking" flickers off during the fetch.
    s = reduce(s, { kind: "session.started", schemaVersion: 1, sessionId: "ses_a" } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
    expect(s.transcript).toHaveLength(1); // the echo survives the session reset

    // turn.started confirms the SAME item (drops `optimistic`) rather than pushing a duplicate.
    s = reduce(s, {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "add a test",
    } as NewEvent);
    expect(s.transcript).toEqual([{ kind: "user", id: expect.any(String), text: "add a test" }]);
  });

  it("turn.started with NO prior optimistic echo still pushes the user item (replay / non-TUI path)", () => {
    const s = reduce(init(), {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "ship it",
    } as NewEvent);
    expect(s.transcript).toEqual([{ kind: "user", id: expect.any(String), text: "ship it" }]);
  });

  it("assistant deltas coalesce into one streaming item, then final settles it", () => {
    let s = init();
    s = reduce(s, { kind: "assistant.delta", ...base, text: "Hel" } as NewEvent);
    s = reduce(s, { kind: "assistant.delta", ...base, text: "lo" } as NewEvent);
    expect(s.transcript).toHaveLength(1);
    const streaming = s.transcript[0];
    expect(streaming).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
    s = reduce(s, { kind: "assistant.final", ...base, text: "" } as NewEvent);
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({ kind: "assistant", text: "Hello", streaming: false });
  });

  it("verify.gate pushes a notice (warn on failure w/ summary, info on pass)", () => {
    let s = init();
    s = reduce(s, {
      kind: "verify.gate",
      ...base,
      ok: false,
      attempt: 0,
      summary: "2 tests failing",
    } as NewEvent);
    const fail = s.transcript.at(-1);
    expect(fail).toMatchObject({ kind: "notice", level: "warn" });
    expect((fail as { text: string }).text).toContain("verification failed");
    expect((fail as { text: string }).text).toContain("2 tests failing");
    s = reduce(s, { kind: "verify.gate", ...base, ok: true, attempt: 1 } as NewEvent);
    expect(s.transcript.at(-1)).toMatchObject({ kind: "notice", level: "info" });
  });

  it("subagent lifecycle: wave→started→tool feed the LIVE panel; finished commits a scrollback line", () => {
    let s = init();
    const sb = { ...base, toolCallId: "tc_p", childSessionId: "ses_c1" };
    // The one-shot wave event fixes the exact size up front.
    s = reduce(s, {
      kind: "subagent.wave",
      ...base,
      toolCallId: "tc_p",
      count: 1,
      role: "scout",
    } as NewEvent);
    expect(s.wave).toMatchObject({ id: "tc_p", total: 1, done: 0, roleWord: "scouts" });
    expect(s.transcript.some((t) => t.kind === "subagent-line")).toBe(false); // nothing in scrollback yet

    s = reduce(s, {
      kind: "subagent.started",
      ...sb,
      role: "scout",
      label: "find-auth",
      model: "z-ai/glm-5.2",
      readOnly: true,
      prompt: "find auth",
    } as NewEvent);
    expect(s.wave?.total).toBe(1); // exact-total wave doesn't double-count on started
    expect(s.wave?.labels.ses_c1).toBe("find-auth");

    s = reduce(s, {
      kind: "subagent.tool",
      ...sb,
      childToolCallId: "tc_c1",
      toolName: "grep",
      status: "running",
      preview: "/auth/",
    } as NewEvent);
    // The live action ring reflects what the child is doing right now (no tall tool-row list).
    expect(s.wave?.actions).toHaveLength(1);
    expect(s.wave?.actions[0]?.text).toContain("/auth/");

    s = reduce(s, {
      kind: "subagent.finished",
      ...sb,
      stopReason: "complete",
      turns: 3,
      toolCount: 1,
      summary: "auth is in middleware/limit.ts",
      durationMs: 12000,
    } as NewEvent);
    // The wave is done → the live panel is gone, and a durable child line + a done line are in scrollback.
    expect(s.wave).toBeUndefined();
    const lines = s.transcript.filter(
      (t): t is Extract<TranscriptItem, { kind: "subagent-line" }> => t.kind === "subagent-line",
    );
    const child = lines.find((l) => l.variant === "child");
    expect(child).toMatchObject({ label: "find-auth", childStatus: "ok", turns: 3 });
    expect(child?.summary).toContain("middleware/limit.ts");
    expect(lines.find((l) => l.variant === "done")).toMatchObject({
      count: 1,
      okCount: 1,
      failCount: 0,
    });
  });

  it("first scout's line commits to scrollback WHILE a sibling still runs (append-only, settle-at-bottom)", () => {
    let s = init();
    s = reduce(s, {
      kind: "subagent.wave",
      ...base,
      toolCallId: "tc_p",
      count: 2,
      role: "scout",
    } as NewEvent);
    for (const c of ["ses_a", "ses_b"]) {
      s = reduce(s, {
        kind: "subagent.started",
        ...base,
        toolCallId: "tc_p",
        childSessionId: c,
        role: "scout",
        label: c,
        model: "m",
        readOnly: true,
        prompt: "x",
      } as NewEvent);
    }
    s = reduce(s, {
      kind: "subagent.finished",
      ...base,
      toolCallId: "tc_p",
      childSessionId: "ses_a",
      stopReason: "complete",
      turns: 1,
      toolCount: 0,
      summary: "done a",
      durationMs: 100,
    } as NewEvent);
    // ses_a's line is already settled + committed while the wave (ses_b) is still live.
    expect(s.wave?.done).toBe(1);
    const firstLive = s.transcript.findIndex((it) => !isSettled(it));
    const aLine = s.transcript.findIndex(
      (t) => t.kind === "subagent-line" && t.variant === "child" && t.label === "ses_a",
    );
    expect(aLine).toBeGreaterThanOrEqual(0);
    expect(firstLive === -1 || aLine < firstLive).toBe(true); // it's in the settled (scrollback) prefix
  });

  it("subagent.delta is a no-op for the view; unknown-parent tool is a no-op", () => {
    let s = init();
    s = reduce(s, { kind: "subagent.wave", ...base, toolCallId: "tc_p", count: 1 } as NewEvent);
    const before = s;
    s = reduce(s, {
      kind: "subagent.delta",
      ...base,
      toolCallId: "tc_p",
      text: "thinking…",
    } as NewEvent);
    expect(s.transcript).toEqual(before.transcript);
    expect(s.wave).toEqual(before.wave);
    // A tool event for a different (unknown) wave id changes nothing.
    const s2 = reduce(s, {
      kind: "subagent.tool",
      ...base,
      toolCallId: "tc_other",
      childSessionId: "ses_x",
      childToolCallId: "tc_y",
      toolName: "read",
      status: "running",
    } as NewEvent);
    expect(s2.wave).toEqual(s.wave);
  });

  it("a whitespace-only delta does NOT open a spinning streaming item", () => {
    let s = init();
    s = reduce(s, { kind: "assistant.delta", ...base, text: "  \n " } as NewEvent);
    // no blank, forever-spinning assistant line was created
    expect(s.transcript.some((t) => t.kind === "assistant")).toBe(false);
    // once real content arrives, the item opens normally
    s = reduce(s, { kind: "assistant.delta", ...base, text: "hi" } as NewEvent);
    expect(s.transcript.some((t) => t.kind === "assistant" && t.streaming)).toBe(true);
  });

  it("tool.drafting says what the agent is about to do while the call streams in", () => {
    let s = init();
    s = reduce(s, { kind: "turn.started", ...base, input: "go" } as NewEvent);
    s = reduce(s, { kind: "tool.drafting", ...base, toolName: "write" } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Writing" });
    s = reduce(s, {
      kind: "tool.drafting",
      ...base,
      toolName: "write",
      path: "src/app.ts",
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Writing", detail: "src/app.ts" });
  });

  it("tool.proposed carries no diff; the diff attaches from tool.result (its OUTPUT)", () => {
    let s = init();
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_1",
      wireId: "w1",
      toolName: "write",
      // the tool INPUT never contains a diff — the reducer must not read one here
      args: { path: "a.ts", content: "hi" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    expect(s.transcript[0]).toMatchObject({
      kind: "tool",
      name: "write",
      preview: "a.ts",
      status: "running",
    });
    expect((s.transcript[0] as Extract<TranscriptItem, { kind: "tool" }>).diff).toBeUndefined();
    // the unified diff rides on tool.result and is attached to the same row
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_1",
      ok: true,
      durationMs: 12,
      diff: "--- a.ts\n+++ a.ts\n+hi",
    } as NewEvent);
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({
      kind: "tool",
      status: "ok",
      durationMs: 12,
      diff: "--- a.ts\n+++ a.ts\n+hi",
    });
  });

  it("a non-diff tool (grep/bash) attaches its OUTPUT preview + exitCode so it isn't just '✓ 34ms'", () => {
    let s = init();
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_g",
      wireId: "w",
      toolName: "grep",
      args: { pattern: "TODO" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_g",
      ok: true,
      durationMs: 12,
      preview: "src/a.ts:12: // TODO fix\nsrc/b.ts:4: // TODO test",
      exitCode: 0,
    } as NewEvent);
    const tool = s.transcript.find((t) => t.kind === "tool") as Extract<
      TranscriptItem,
      { kind: "tool" }
    >;
    expect(tool.resultPreview).toContain("TODO fix");
    // a write/edit result (has a diff) must NOT also show the raw JSON output preview
    let s2 = init();
    s2 = reduce(s2, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_w",
      wireId: "w",
      toolName: "write",
      args: { path: "a.ts", content: "x" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    s2 = reduce(s2, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_w",
      ok: true,
      durationMs: 3,
      diff: "--- a.ts\n+++ a.ts\n+x",
      preview: '{"path":"a.ts","operation":"create"}',
    } as NewEvent);
    const wtool = s2.transcript.find((t) => t.kind === "tool") as Extract<
      TranscriptItem,
      { kind: "tool" }
    >;
    expect(wtool.diff).toContain("+x");
    expect(wtool.resultPreview).toBeUndefined();
  });

  it("a tool.result with no matching row (e.g. a folded plan call) is a no-op, not a crash", () => {
    const s0 = init();
    const s = reduce(s0, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_missing",
      ok: true,
      durationMs: 4,
    } as NewEvent);
    expect(s.transcript).toHaveLength(0); // no phantom row
    expect(s.plan).toEqual(s0.plan);
    expect(s.status.requestedModel).toBe(s0.status.requestedModel); // no phantom telemetry bumped
    // a folded/unknown result resets the activity to Thinking so a stale tool verb never sticks
    expect(s.status.activity).toEqual({ verb: "Thinking" });
  });

  it("model.resolved surfaces a substitution notice and records the served model", () => {
    const s = reduce(init(), {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "z-ai/glm-5.2",
      targetModel: "moonshotai/kimi-k2.7-code",
      lane: "direct",
      rule: "warm-substitute",
      reason: "cold",
    } as NewEvent);
    expect(s.status.targetModel).toBe("moonshotai/kimi-k2.7-code");
    expect(s.status.lane).toBe("direct");
    // substitution surfaces a calm, honest RECEIPT (short model names, no em-dash)
    expect(
      s.transcript.some((t) => t.kind === "receipt" && t.text.includes("served by kimi-k2.7-code")),
    ).toBe(true);
  });

  it("no substitution notice when served === requested", () => {
    const s = reduce(init(), {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "moonshotai/kimi-k2.7-code",
      targetModel: "moonshotai/kimi-k2.7-code",
      lane: "direct",
      rule: "exact",
    } as NewEvent);
    expect(s.transcript).toHaveLength(0);
  });

  it("a mid-run handoff updates the flightline's target + lane AND shows a row", () => {
    let s = reduce(init(), {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "z-ai/glm-5.2",
      targetModel: "z-ai/glm-5.2",
      lane: "direct",
      rule: "exact",
    } as NewEvent);
    s = reduce(s, {
      kind: "handoff",
      ...base,
      from: "z-ai/glm-5.2",
      to: "moonshotai/kimi-k2.7-code",
      role: "executor",
      lane: "direct",
      reason: "glm-5.2 is cold; failing over to a warm model",
    } as NewEvent);
    // the served model + lane follow the failover even if the response omits reportedModel
    expect(s.status.targetModel).toBe("moonshotai/kimi-k2.7-code");
    expect(s.status.lane).toBe("direct");
    expect(
      s.transcript.some((t) => t.kind === "handoff" && t.to === "moonshotai/kimi-k2.7-code"),
    ).toBe(true);
  });

  it("a handoff CLEARS the prior model's reportedModel (flightline never names the failed model)", () => {
    let s = reduce(init(), {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "z-ai/glm-5.2",
      targetModel: "z-ai/glm-5.2",
      lane: "direct",
      rule: "exact",
    } as NewEvent);
    // an earlier successful inference reported model A…
    s = reduce(s, {
      kind: "inference.response",
      ...base,
      empty: false,
      truncated: false,
      reportedModel: "z-ai/glm-5.2",
    } as NewEvent);
    expect(s.status.reportedModel).toBe("z-ai/glm-5.2");
    // …then a failover to B whose response omits reportedModel: the stale A must not persist.
    s = reduce(s, {
      kind: "handoff",
      ...base,
      from: "z-ai/glm-5.2",
      to: "moonshotai/kimi-k2.7-code",
      role: "executor",
      lane: "direct",
    } as NewEvent);
    expect(s.status.reportedModel).toBeUndefined();
    expect(s.status.targetModel).toBe("moonshotai/kimi-k2.7-code");
  });

  it("assistant.final's non-empty text is canonical (restores dropped leading indentation)", () => {
    let s = init();
    // the leading-whitespace delta is dropped by the spin guard, so the streamed text loses its indent…
    s = reduce(s, { kind: "assistant.delta", ...base, text: "    " } as NewEvent);
    s = reduce(s, { kind: "assistant.delta", ...base, text: "const x = 1" } as NewEvent);
    // …but the final carries the complete indented text and must win when settling.
    s = reduce(s, { kind: "assistant.final", ...base, text: "    const x = 1" } as NewEvent);
    const a = s.transcript.find((t) => t.kind === "assistant") as Extract<
      TranscriptItem,
      { kind: "assistant" }
    >;
    expect(a.text).toBe("    const x = 1");
    expect(a.streaming).toBe(false);
  });

  it("inference.response folds the reported (actually-serving) model", () => {
    const s = reduce(init(), {
      kind: "inference.response",
      ...base,
      empty: false,
      truncated: false,
      reportedModel: "deepseek/deepseek-v4-flash-0731",
    } as NewEvent);
    expect(s.status.reportedModel).toBe("deepseek/deepseek-v4-flash-0731");
  });

  it("context.preflight feeds the status gauge; turn.finished clears running", () => {
    let s = reduce(init(), {
      kind: "context.preflight",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      model: "m",
      contextWindow: 128000,
      promptEstimate: 4000,
      reserve: 1000,
      requestedOutput: 2048,
      sentOutput: 2048,
      remainingShared: 120000,
    } as NewEvent);
    expect(s.status.contextWindow).toBe(128000);
    expect(s.status.promptEstimate).toBe(4000);
    s = reduce({ ...s, status: { ...s.status, running: true } }, {
      kind: "turn.finished",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      stopReason: "complete",
    } as NewEvent);
    expect(s.status.running).toBe(false);
  });

  it("a REAL error is a red notice; withStop records the stop reason", () => {
    let s = reduce(init(), {
      kind: "error",
      schemaVersion: 1,
      sessionId: "ses_a",
      errorKind: "auth",
      message: "bad key",
    } as NewEvent);
    expect(s.transcript[0]).toMatchObject({ kind: "notice", level: "error" });
    s = withStop(s, "complete");
    expect(s.status.stopReason).toBe("complete");
    expect(s.status.running).toBe(false);
  });

  it("rate_limit / cold are CALM transient notices (dim, deduped) — not a wall of red", () => {
    let s = init();
    const rl = {
      kind: "error",
      schemaVersion: 1,
      sessionId: "ses_a",
      errorKind: "rate_limit",
      message: "Rate limited by Ambient",
      model: "moonshotai/kimi-k2.7-code",
    } as NewEvent;
    s = reduce(s, rl);
    s = reduce(s, rl); // a burst of identical retries…
    s = reduce(s, rl);
    const notices = s.transcript.filter((t) => t.kind === "notice");
    expect(notices).toHaveLength(1); // …collapses to ONE line
    expect(notices[0]).toMatchObject({ level: "info" }); // calm/dim, not "error"
    expect((notices[0] as Extract<TranscriptItem, { kind: "notice" }>).text).toContain("busy");
  });

  it("session.started resets run-scoped status (a second task never shows a stale model/gauge)", () => {
    let s = init();
    for (let i = 0; i < 3; i++) {
      s = reduce(s, {
        kind: "turn.started",
        schemaVersion: 1,
        sessionId: "ses_a",
        turnId: "trn_a",
        input: `t${i}`,
      } as NewEvent);
    }
    s = reduce(s, {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "a",
      targetModel: "b",
      lane: "direct",
      rule: "r",
      reason: "warm",
    } as NewEvent);
    s = reduce(s, {
      kind: "context.preflight",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      model: "b",
      contextWindow: 128000,
      promptEstimate: 40000,
      reserve: 1000,
      requestedOutput: 2048,
      sentOutput: 2048,
      remainingShared: 80000,
    } as NewEvent);
    s = withStop(s, "complete");
    // a NEW run begins
    s = reduce(s, {
      kind: "session.started",
      schemaVersion: 1,
      sessionId: "ses_b",
      cwd: "/w",
      workspaceRoot: "/w",
    } as NewEvent);
    expect(s.status.stopReason).toBeUndefined();
    expect(s.status.targetModel).toBeUndefined();
    expect(s.status.lane).toBeUndefined();
    expect(s.status.contextWindow).toBeUndefined();
    expect(s.status.promptEstimate).toBeUndefined();
    expect(s.status.running).toBe(true);
    // history is preserved across runs
    expect(s.transcript.length).toBeGreaterThan(0);
  });

  it("withStop terminalizes in-flight items (streaming stops, running tools fail)", () => {
    let s = init();
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_1",
      wireId: "w",
      toolName: "bash",
      args: { command: "sleep 99" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    s = reduce(s, { kind: "assistant.delta", ...base, text: "thinking" } as NewEvent);
    expect(s.transcript.some((t) => t.kind === "assistant" && t.streaming)).toBe(true);
    expect(s.transcript.some((t) => t.kind === "tool" && t.status === "running")).toBe(true);
    s = withStop(s, "cancelled");
    expect(s.transcript.some((t) => t.kind === "assistant" && t.streaming)).toBe(false);
    const tool = s.transcript.find((t) => t.kind === "tool") as Extract<
      TranscriptItem,
      { kind: "tool" }
    >;
    expect(tool.status).toBe("fail");
    expect(tool.error).toBe("cancelled");
  });

  it("assistant.final closes a streaming assistant even when a tool was pushed after it", () => {
    let s = init();
    s = reduce(s, { kind: "assistant.delta", ...base, text: "let me check" } as NewEvent);
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_9",
      wireId: "w",
      toolName: "read",
      args: { path: "a.ts" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    s = reduce(s, { kind: "assistant.final", ...base, text: "" } as NewEvent);
    expect(s.transcript.some((t) => t.kind === "assistant" && t.streaming)).toBe(false);
  });

  it("reduce is deterministic/pure — same (state, event) yields identical ids", () => {
    const s0 = init();
    const ev = {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "x",
    } as NewEvent;
    const a = reduce(s0, ev);
    const b = reduce(s0, ev);
    expect(a).toEqual(b); // no module-global counter — replay/double-invoke are stable
    expect(a.seq).toBe(1);
  });

  it("the plan tool folds into state.plan and does NOT show a transcript row; resets per session", () => {
    let s = init();
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_p",
      wireId: "w",
      toolName: "plan",
      args: {
        tasks: [
          { text: "read the code", status: "done" },
          { text: "write the fix", status: "active" },
          { text: "run tests", status: "pending" },
        ],
      },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    expect(s.plan).toEqual([
      { text: "read the code", status: "done" },
      { text: "write the fix", status: "active" },
      { text: "run tests", status: "pending" },
    ]);
    expect(s.transcript.some((t) => t.kind === "tool")).toBe(false); // no tool row for the plan
    // the plan's own tool.result has no matching row and must NOT create phantom state
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_p",
      ok: true,
      durationMs: 1,
    } as NewEvent);
    expect(s.transcript.some((t) => t.kind === "tool")).toBe(false);
    // malformed / bad status is coerced to pending; non-string text is dropped
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_p2",
      wireId: "w",
      toolName: "plan",
      args: {
        tasks: [
          { text: "ok", status: "weird" },
          { text: 42, status: "done" },
        ],
      },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    expect(s.plan).toEqual([{ text: "ok", status: "pending" }]);
    const started = {
      kind: "session.started",
      schemaVersion: 1,
      sessionId: "ses_b",
      cwd: "/w",
      workspaceRoot: "/w",
    } as NewEvent;
    // an UNFINISHED plan carries into the next run (the agent is seeded with it, so the panel must show it)
    s = reduce(s, started);
    expect(s.plan).toEqual([{ text: "ok", status: "pending" }]);
    // a FINISHED plan is retired when the next run starts
    s = { ...s, plan: [{ text: "ok", status: "done" }] };
    s = reduce(s, started);
    expect(s.plan).toEqual([]);
  });

  it("tracks the live ACTIVITY: Thinking → tool verb → back to Thinking → cleared on finish", () => {
    let s = init();
    s = reduce(s, {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "edit the router",
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
    // proposal is recorded but does NOT drive the activity (all proposals emit up front, not in exec order)
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_e",
      wireId: "w",
      toolName: "edit",
      args: { path: "src/router.ts", oldString: "a", newString: "b" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" }); // unchanged until it actually STARTS
    // it actually starts executing → "Editing <path>"
    s = reduce(s, {
      kind: "tool.started",
      ...base,
      toolCallId: "tc_e",
      toolName: "edit",
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Editing", detail: "src/router.ts" });
    // when it finishes, the agent goes back to the model → "Thinking"
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_e",
      ok: true,
      durationMs: 3,
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
    // turn finished → activity cleared (the live line disappears)
    s = reduce(s, {
      kind: "turn.finished",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      stopReason: "complete",
    } as NewEvent);
    expect(s.status.activity).toBeUndefined();
  });

  it("parallel tools: a finished tool keeps the activity on a still-running sibling, not 'Thinking'", () => {
    let s = init();
    const start = (id: string, name: string, args: unknown) => {
      s = reduce(s, {
        kind: "tool.proposed",
        ...base,
        toolCallId: id,
        wireId: "w",
        toolName: name,
        args,
        rawArgs: "{}",
        argsHash: "h",
      } as NewEvent);
      s = reduce(s, { kind: "tool.started", ...base, toolCallId: id, toolName: name } as NewEvent);
    };
    start("tc_a", "read", { path: "a.ts" });
    start("tc_b", "grep", { pattern: "TODO" });
    // tc_a finishes but tc_b is still running → the line follows tc_b, NOT "Thinking"
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_a",
      ok: true,
      durationMs: 1,
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Searching", detail: "TODO" });
    // now tc_b finishes too → back to Thinking
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_b",
      ok: true,
      durationMs: 1,
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
  });

  it("slash helpers: appendNotice pushes a notice, clearTranscript empties, setRequestedModel updates", () => {
    let s = init();
    s = reduce(s, {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "x",
    } as NewEvent);
    s = appendNotice(s, "info", "model set to z-ai/glm-5.2");
    expect(s.transcript.some((t) => t.kind === "notice" && t.text.includes("glm-5.2"))).toBe(true);
    s = setRequestedModel(s, "z-ai/glm-5.2");
    expect(s.status.requestedModel).toBe("z-ai/glm-5.2");
    s = clearTranscript(s);
    expect(s.transcript).toHaveLength(0);
    expect(s.plan).toHaveLength(0);
    expect(s.status.requestedModel).toBe("z-ai/glm-5.2"); // status is preserved across a clear
  });

  it("two axes: Tab toggles plan/build, Shift+Tab cycles permission, runtime mode derives", () => {
    expect(toggleAgentMode("plan")).toBe("build");
    expect(toggleAgentMode("build")).toBe("plan");
    expect(nextPermission("ask")).toBe("accept-edits");
    expect(nextPermission("accept-edits")).toBe("bypass");
    expect(nextPermission("bypass")).toBe("ask");
    expect(toRuntimeMode("plan", "bypass")).toBe("plan");
    expect(toRuntimeMode("build", "bypass")).toBe("bypass");
    expect(toRuntimeMode("build", "ask")).toBe("ask");
  });

  it("reduce never mutates the input state (immutability)", () => {
    const s0 = init();
    const frozen = Object.freeze(s0);
    const s1 = reduce(frozen, {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "x",
    } as NewEvent);
    expect(s1).not.toBe(s0);
    expect(s0.transcript).toHaveLength(0);
  });
});

describe("tui reducer — subagent visibility", () => {
  const startGroup = (s: ReturnType<typeof init>) =>
    reduce(s, {
      kind: "subagent.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      attemptId: "att_a",
      toolCallId: "tc_p",
      childSessionId: "ses_c",
      role: "scout",
      label: "find-auth",
      model: "qwen",
      readOnly: true,
      prompt: "find the auth flow",
    } as NewEvent);

  it("subagent.tool surfaces the child's action in the always-on activity line (not a frozen 'Delegating')", () => {
    let s = startGroup(init());
    s = reduce(s, {
      kind: "subagent.tool",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      attemptId: "att_a",
      toolCallId: "tc_p",
      childSessionId: "ses_c",
      childToolCallId: "tc_1",
      toolName: "grep",
      status: "running",
      preview: "/auth/",
    } as NewEvent);
    expect(s.status.activity?.verb).toContain("find-auth"); // WHICH subagent
    expect(s.status.activity?.detail).toContain("/auth/"); // …and WHAT it's doing
  });

  it("on a child tool SETTLE the activity line shows a neutral 'working', not the stale completed action", () => {
    const tool = (status: "running" | "ok", preview: string) =>
      ({
        kind: "subagent.tool",
        schemaVersion: 1,
        sessionId: "ses_a",
        turnId: "trn_a",
        attemptId: "att_a",
        toolCallId: "tc_p",
        childSessionId: "ses_c",
        childToolCallId: "tc_1",
        toolName: "grep",
        status,
        preview,
      }) as NewEvent;
    let s = startGroup(init());
    s = reduce(s, tool("running", "/auth/"));
    expect(s.status.activity?.detail).toContain("/auth/"); // running → shows the action
    s = reduce(s, tool("ok", "12 hits"));
    expect(s.status.activity?.verb).toContain("find-auth");
    expect(s.status.activity?.detail).toBe("working"); // settled → neutral, NOT "searching 12 hits"
  });

  it("subagent.delta is a no-op for the view (per-token prose no longer drives a tall re-rendering panel)", () => {
    const s0 = startGroup(init());
    const s1 = reduce(s0, {
      kind: "subagent.delta",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      attemptId: "att_a",
      toolCallId: "tc_p",
      text: "looking at the login handler",
    } as NewEvent);
    expect(s1.transcript).toEqual(s0.transcript);
    expect(s1.wave).toEqual(s0.wave);
  });

  it("a child that hit its turn limit is PARTIAL (it returned findings), not failed", () => {
    let s = reduce(init(), {
      kind: "subagent.wave",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      attemptId: "att_a",
      toolCallId: "tc_p",
      count: 1,
      role: "scout",
      labels: ["find-auth"],
    } as NewEvent);
    s = startGroup(s);
    s = reduce(s, {
      kind: "subagent.finished",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      attemptId: "att_a",
      toolCallId: "tc_p",
      childSessionId: "ses_c",
      stopReason: "max_turns",
      turns: 30,
      toolCount: 5,
      summary: "found 3 issues before running out of turns",
      durationMs: 60_000,
    } as NewEvent);
    const child = s.transcript.find(
      (t): t is Extract<TranscriptItem, { kind: "subagent-line" }> =>
        t.kind === "subagent-line" && t.variant === "child",
    );
    expect(child?.childStatus).toBe("partial"); // NOT "fail" — the summary reached the parent
    const done = s.transcript.find(
      (t): t is Extract<TranscriptItem, { kind: "subagent-line" }> =>
        t.kind === "subagent-line" && t.variant === "done",
    );
    expect(done?.partialCount).toBe(1);
    expect(done?.failCount).toBe(0);
    expect(done?.okCount).toBe(0);
  });

  it("run.checkpoint (auto_continue) pushes a visible 'continuing' marker; a pause does not", () => {
    const cont = reduce(init(), {
      kind: "run.checkpoint",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      segment: 1,
      of: 3,
      reason: "auto_continue",
    } as NewEvent);
    const marker = cont.transcript.at(-1);
    expect(marker?.kind).toBe("notice");
    expect(marker?.kind === "notice" ? marker.text : "").toContain("continuing");

    const paused = reduce(init(), {
      kind: "run.checkpoint",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      segment: 0,
      of: 3,
      reason: "paused",
    } as NewEvent);
    expect(paused.transcript).toEqual(init().transcript); // no marker — the stop notice covers a pause
  });
});

describe("withStop — legible end-of-run notice", () => {
  it("max_turns appends a warn notice explaining the stop + how to continue", () => {
    const s = withStop(init(), "max_turns");
    const last = s.transcript.at(-1);
    expect(last?.kind).toBe("notice");
    if (last?.kind === "notice") {
      expect(last.level).toBe("warn");
      expect(last.text).toContain("turn limit");
      expect(last.text.toLowerCase()).toContain("continue");
    }
    expect(s.status.stopReason).toBe("max_turns");
  });

  it("a clean complete (and a user cancel) add NO extra notice", () => {
    expect(withStop(init(), "complete").transcript).toEqual(init().transcript);
    expect(withStop(init(), "cancelled").transcript).toEqual(init().transcript);
  });
});

describe("tui reducer — steer", () => {
  it("a steer event shows the injected message as a user turn in the transcript", () => {
    const s = reduce(init(), {
      kind: "steer",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      text: "actually, also run the tests",
    } as NewEvent);
    expect(s.transcript).toEqual([
      { kind: "user", id: expect.any(String), text: "actually, also run the tests" },
    ]);
  });
});

describe("tui reducer — run telemetry (effort / round / tokens)", () => {
  const started = () =>
    ({ kind: "session.started", schemaVersion: 1, sessionId: "ses_a" }) as NewEvent;
  const inf = (over: Record<string, unknown>) =>
    ({ kind: "inference.response", ...base, empty: false, truncated: false, ...over }) as NewEvent;

  it("folds the resolved effort and accumulates tokens across model calls", () => {
    let s = reduce(init(), started());
    s = reduce(s, inf({ effort: "high", promptTokens: 100, completionTokens: 20 }));
    expect(s.status.resolvedEffort).toBe("high");
    expect(s.status.tokensUsed).toBe(120);
    s = reduce(s, inf({ effort: "high", promptTokens: 50, completionTokens: 10 }));
    expect(s.status.tokensUsed).toBe(180); // cumulative
  });

  it("keeps cumulative tokens across runs; a NaN/absent usage never pollutes the count", () => {
    let s = reduce(init(), started());
    s = reduce(s, inf({ promptTokens: 100, completionTokens: 0 }));
    expect(s.status.tokensUsed).toBe(100);
    s = reduce(s, started()); // a new run
    s = reduce(s, inf({ effort: "medium" })); // no token fields → no change to the running total
    expect(s.status.tokensUsed).toBe(100); // tokens persist across the session, no NaN
  });
});

describe("isSettled — the Static/live split for scrollback", () => {
  it("in-flight items are LIVE (re-rendered), finalized items are SETTLED (committed to scrollback)", () => {
    // live
    expect(isSettled({ kind: "assistant", id: "a", text: "…", streaming: true, spin: 0 })).toBe(
      false,
    );
    expect(
      isSettled({ kind: "tool", id: "t", name: "bash", preview: "$ x", status: "running" }),
    ).toBe(false);
    // A subagent-line is a durable scrollback record — ALWAYS settled (it never mutates after it's pushed).
    expect(
      isSettled({
        kind: "subagent-line",
        id: "s",
        variant: "child",
        roleWord: "scouts",
        label: "x",
      }),
    ).toBe(true);
    // settled — a user item is ALWAYS settled, even an optimistic echo: its text never changes, and treating
    // it as live would freeze the split forever if a run aborts before turn.started clears the flag.
    expect(isSettled({ kind: "user", id: "u", text: "hi", optimistic: true })).toBe(true);
    expect(isSettled({ kind: "assistant", id: "a", text: "done", streaming: false, spin: 0 })).toBe(
      true,
    );
    expect(
      isSettled({
        kind: "tool",
        id: "t",
        name: "bash",
        preview: "$ x",
        status: "ok",
        durationMs: 3,
      }),
    ).toBe(true);
    expect(isSettled({ kind: "user", id: "u", text: "hi" })).toBe(true);
    expect(isSettled({ kind: "notice", id: "n", level: "info", text: "ok" })).toBe(true);
  });

  it("keeps the settled prefix APPEND-ONLY when a later tool settles before an earlier one", () => {
    // Two parallel tools: the SECOND settles first. The settled PREFIX must stop at the first still-running
    // tool (so <Static> never sees an item reordered), not include the out-of-order settled one.
    const transcript: TranscriptItem[] = [
      { kind: "user", id: "u", text: "go" },
      { kind: "tool", id: "t1", name: "grep", preview: "/a/", status: "running" },
      { kind: "tool", id: "t2", name: "grep", preview: "/b/", status: "ok", durationMs: 2 },
    ];
    const firstLive = transcript.findIndex((it) => !isSettled(it));
    expect(firstLive).toBe(1); // stops at the running t1 — t2 stays in the live tail until t1 settles
  });
});

describe("activity clarity — parallel tools name WHAT, not a bare 'N tools'", () => {
  const proposeStart = (s: ReturnType<typeof init>, id: string, name: string, args: object) => {
    let n = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: id,
      wireId: id,
      toolName: name,
      args,
      rawArgs: JSON.stringify(args),
      argsHash: id,
    } as NewEvent);
    n = reduce(n, { kind: "tool.started", ...base, toolCallId: id, toolName: name } as NewEvent);
    return n;
  };

  it("with 2+ tools still in flight, the activity line lists the distinct verbs", () => {
    let s = init();
    s = proposeStart(s, "tc1", "read", { path: "a.ts" });
    s = proposeStart(s, "tc2", "grep", { pattern: "foo" });
    s = proposeStart(s, "tc3", "edit", { path: "b.ts" });
    // one finishes → two remain in flight → the line names them, not "3 tools".
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc1",
      ok: true,
      durationMs: 3,
    } as NewEvent);
    expect(s.status.activity?.verb).toBe("Running");
    expect(s.status.activity?.detail).toContain("2 tools");
    expect(s.status.activity?.detail).toContain("searching"); // grep
    expect(s.status.activity?.detail).toContain("editing"); // edit
  });
});

describe("splitCommittable — the incremental <Static> commit boundary (pure)", () => {
  it("returns null when there is no completed paragraph yet", () => {
    expect(splitCommittable("")).toBeNull();
    expect(splitCommittable("one paragraph, still going")).toBeNull();
    expect(splitCommittable("line one\nline two — a single paragraph")).toBeNull(); // single \n is not a break
  });

  it("commits completed paragraphs and keeps the last one live", () => {
    expect(splitCommittable("Para 1\n\nPara 2 in progress")).toEqual({
      commit: "Para 1",
      live: "Para 2 in progress",
    });
    // Commits ALL completed paragraphs at once, preserving the internal blank line in the committed chunk.
    expect(splitCommittable("Para 1\n\nPara 2\n\nPara 3 partial")).toEqual({
      commit: "Para 1\n\nPara 2",
      live: "Para 3 partial",
    });
  });

  it("never commits the final paragraph even with a trailing blank line", () => {
    // A trailing \n\n means the last paragraph isn't 'followed by content' → nothing after is committable.
    expect(splitCommittable("Only one\n\n")).toBeNull();
    // Para 2 stays live and KEEPS its trailing break, so a continued 'Para 3' still starts a new paragraph.
    expect(splitCommittable("Para 1\n\nPara 2\n\n")).toEqual({
      commit: "Para 1",
      live: "Para 2\n\n",
    });
  });

  it("never commits inside an OPEN code fence (indentation there is load-bearing + unrevertable)", () => {
    // The blank line sits inside an open ``` fence → not committable; keep the whole thing live.
    expect(splitCommittable("Intro text\n\n```js\nconst a = 1;\n\nconst b = 2;")).toEqual({
      commit: "Intro text",
      live: "```js\nconst a = 1;\n\nconst b = 2;",
    });
    // A blank line INSIDE the open fence alone is not a commit point.
    expect(splitCommittable("```js\nconst a = 1;\n\nconst b = 2; still coding")).toBeNull();
  });

  it("commits a CLOSED code block as a unit once the fence balances", () => {
    const text = "```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the block";
    expect(splitCommittable(text)).toEqual({
      commit: "```js\nconst a = 1;\n\nconst b = 2;\n```",
      live: "After the block",
    });
  });
});

describe("assistant streaming → incremental <Static> commit (reducer)", () => {
  const stream = (chunks: string[]) => {
    let s = init();
    for (const c of chunks) {
      s = reduce(s, { kind: "assistant.delta", ...base, text: c } as NewEvent);
    }
    return s;
  };
  const assistantText = (s: ReturnType<typeof init>) =>
    s.transcript.filter(
      (t): t is Extract<TranscriptItem, { kind: "assistant" }> => t.kind === "assistant",
    );

  it("splits a multi-paragraph answer: completed paragraphs settle, only the tail stays streaming", () => {
    const s = stream(["Para one.\n\n", "Para two.\n\n", "Para three (in progress)"]);
    const a = assistantText(s);
    // committed 'Para one.' + 'Para two.' settled; the last paragraph is the sole streaming item.
    const streaming = a.filter((t) => t.streaming);
    const settled = a.filter((t) => !t.streaming);
    expect(streaming).toHaveLength(1);
    expect(streaming[0]?.text).toBe("Para three (in progress)");
    expect(settled.map((t) => t.text).join(" | ")).toContain("Para one.");
    expect(settled.map((t) => t.text).join(" | ")).toContain("Para two.");
  });

  it("finalize keeps the streamed suffix (never re-applies finalText over a committed answer → no dup)", () => {
    let s = stream(["Alpha.\n\n", "Bravo tail"]);
    // finalText is the WHOLE answer; because a paragraph was committed, the suffix must NOT be overwritten by it.
    s = reduce(s, { kind: "assistant.final", ...base, text: "Alpha.\n\nBravo tail" } as NewEvent);
    const a = assistantText(s);
    expect(a.every((t) => !t.streaming)).toBe(true); // all settled after final
    // 'Alpha.' appears exactly once (committed), 'Bravo tail' exactly once (the finalized suffix) — no duplicate.
    const joined = a.map((t) => t.text).join("");
    expect(joined.match(/Alpha\./g) ?? []).toHaveLength(1);
    expect(joined.match(/Bravo tail/g) ?? []).toHaveLength(1);
  });

  it("a single-paragraph answer still uses finalText (unchanged behavior when nothing was committed)", () => {
    let s = stream(["Just one paragraph, no breaks"]);
    s = reduce(s, {
      kind: "assistant.final",
      ...base,
      text: "  Just one paragraph, no breaks (final-corrected)",
    } as NewEvent);
    const a = assistantText(s);
    expect(a).toHaveLength(1);
    expect(a[0]?.streaming).toBe(false);
    expect(a[0]?.text).toBe("  Just one paragraph, no breaks (final-corrected)");
  });
});

describe("vision relay activity", () => {
  it("shows which model is looking at the image and for whom, then a receipt with what it produced", () => {
    let s = initialState({
      agentMode: "build",
      permission: "ask",
      effort: "auto",
      requestedModel: "z/glm",
    });
    s = reduce(s, {
      kind: "vision.relay.started",
      schemaVersion: 1,
      sessionId: "s",
      turnId: "t",
      targetModel: "z-ai/glm-5.2",
      visionModel: "qwen/qwen3.6-27b",
      imageCount: 1,
    } as NewEvent);
    expect(s.status.activity?.verb).toBe("Looking at your image");
    expect(s.status.activity?.detail).toContain("qwen3.6-27b");
    s = reduce(s, {
      kind: "vision.relay",
      schemaVersion: 1,
      sessionId: "s",
      turnId: "t",
      targetModel: "z-ai/glm-5.2",
      imageCount: 1,
      outcome: "described",
      visionModel: "qwen/qwen3.6-27b",
      descriptionChars: 1420,
    } as NewEvent);
    const last = s.transcript.at(-1) as { text?: string } | undefined;
    expect(last?.text).toContain("described it (1,420 chars)");
  });
});
