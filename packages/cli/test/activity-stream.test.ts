import type { NewEvent } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { streamStats } from "../src/tui/components/ActivityLine.js";
import { type ViewState, initialState, reduce } from "../src/tui/state.js";

const base = { schemaVersion: 1 as const, sessionId: "ses_a", turnId: "trn_a", attemptId: "att_a" };
const init = () =>
  initialState({ agentMode: "build", permission: "ask", effort: "auto", requestedModel: "m/x" });
const run = (events: Array<[NewEvent, number]>, from: ViewState = init()) =>
  events.reduce((s, [ev, at]) => reduce(s, ev, at), from);

const request = (effort?: "high" | "max"): NewEvent => ({
  ...base,
  kind: "inference.request",
  targetModel: "m/x",
  sentOutput: 8192,
  escalation: 0,
  ...(effort ? { effort } : {}),
});
const reasoning = (text: string): NewEvent => ({ ...base, kind: "reasoning.delta", text });
const answer = (text: string): NewEvent => ({ ...base, kind: "assistant.delta", text });

describe("thinking is kept as a row once the model answers", () => {
  it("records how long it reasoned, at the effort sent with that call", () => {
    const s = run([
      [request("max"), 1_000],
      [reasoning("let me think"), 2_000],
      [reasoning(" more"), 9_000],
      [answer("Here is the fix."), 14_500],
    ]);
    const thought = s.transcript.find((t) => t.kind === "thought");
    expect(thought).toMatchObject({ kind: "thought", seconds: 12.5, effort: "max" });
    // The thought row sits above the answer.
    expect(s.transcript.map((t) => t.kind)).toEqual(["thought", "assistant"]);
    expect(s.status.activity?.verb).toBe("Answering");
  });
  it("also records it when the model goes straight to a tool", () => {
    const s = run([
      [request("high"), 1_000],
      [reasoning("look at the file"), 1_500],
      [
        {
          ...base,
          kind: "tool.proposed",
          toolCallId: "tc_1",
          wireId: "w1",
          toolName: "read",
          args: { path: "a.ts" },
        } as NewEvent,
        4_500,
      ],
    ]);
    expect(s.transcript[0]).toMatchObject({ kind: "thought", seconds: 3 });
  });
  it("adds no row when there was no reasoning, or no clock (replay)", () => {
    expect(
      run([
        [request(), 1],
        [answer("hi"), 2],
      ]).transcript.some((t) => t.kind === "thought"),
    ).toBe(false);
    const replay = [request("high"), reasoning("x"), answer("y")].reduce(
      (s, ev) => reduce(s, ev),
      init(),
    );
    expect(replay.transcript.some((t) => t.kind === "thought")).toBe(false);
  });
});

describe("live output stats", () => {
  it("counts streamed text from the start of each call and takes the exact count when reported", () => {
    let s = run([
      [request(), 1_000],
      [reasoning("a".repeat(350)), 2_000],
      [answer("b".repeat(350)), 3_000],
    ]);
    expect(s.status.stream?.chars).toBe(700);
    // Measured from the first token (at 2s), not from the request — prompt reading isn't output time.
    expect(streamStats("Answering", s.status.stream, 12_000)).toBe("↓ 200 tok  ·  20 tok/s");
    s = reduce(
      s,
      {
        ...base,
        kind: "inference.response",
        completionTokens: 1_234,
        empty: false,
        truncated: false,
      },
      11_000,
    );
    expect(streamStats("Answering", s.status.stream, 11_000)).toBe("↓ 1.2k tok  ·  137 tok/s");
    // A new call starts from zero.
    s = reduce(s, request(), 12_000);
    expect(s.status.stream?.chars).toBe(0);
  });
  it("shows nothing during tool work or before the first token", () => {
    expect(streamStats("Reading", { chars: 700, since: 0 }, 5_000)).toBeUndefined();
    expect(streamStats("Thinking", { chars: 0, since: 0 }, 5_000)).toBeUndefined();
    expect(streamStats("Thinking", { chars: 700, since: 4_000 }, 5_000)).toBe("↓ 200 tok"); // too soon for a rate
  });
});

describe("tool verbs", () => {
  const verbFor = (toolName: string, args: unknown) =>
    run([
      [
        {
          ...base,
          kind: "tool.proposed",
          toolCallId: "tc_1",
          wireId: "w",
          toolName,
          args,
        } as NewEvent,
        1,
      ],
      [{ ...base, kind: "tool.started", toolCallId: "tc_1" } as NewEvent, 2],
    ]).status.activity;
  it("names what apply_patch, read_artifact and ask_vision are doing", () => {
    expect(verbFor("apply_patch", { edits: [{ path: "a.ts" }, { path: "a.ts" }] })).toEqual({
      verb: "Editing",
      detail: "a.ts",
    });
    expect(verbFor("apply_patch", { edits: [{ path: "a.ts" }, { path: "b.ts" }] })?.detail).toBe(
      "2 files",
    );
    expect(verbFor("read_artifact", { handle: "h" })?.verb).toBe("Reading saved output");
    expect(verbFor("ask_vision", { image: 1, question: "what error?" })).toEqual({
      verb: "Asking about an image",
      detail: "what error?",
    });
  });
});

describe("reasoning that arrives mid-answer", () => {
  it("stays part of the same reply — no split answer, no second thought row, nothing left streaming", () => {
    const final: NewEvent = { ...base, kind: "assistant.final", text: "Hello world" };
    const s = run([
      [request("high"), 1_000],
      [reasoning("plan it"), 2_000],
      [answer("Hello "), 3_000],
      [reasoning("\n"), 3_100],
      [reasoning("more thought"), 3_200],
      [answer("world"), 3_300],
      [final, 3_400],
    ]);
    expect(s.transcript.map((t) => t.kind)).toEqual(["thought", "assistant"]);
    const reply = s.transcript[1] as { text: string; streaming: boolean };
    expect(reply.text).toBe("Hello world");
    expect(reply.streaming).toBe(false);
  });
});

describe("effort shown after a failover", () => {
  it("clears when the next request goes to a model that doesn't reason", () => {
    let s = run([[request("max"), 1_000]]);
    expect(s.status.resolvedEffort).toBe("max");
    s = reduce(s, request(), 2_000);
    expect(s.status.resolvedEffort).toBeUndefined();
  });
});

describe("model names in notes", () => {
  it("drop the vendor for a versioned name but keep it for a bare alias", async () => {
    const { shortName } = await import("../src/tui/state.js");
    expect(shortName("z-ai/glm-5.2")).toBe("glm-5.2");
    expect(shortName("qwen/qwen3.8-27b")).toBe("qwen3.8-27b");
    expect(shortName("ambient/large")).toBe("ambient/large");
    expect(shortName("m")).toBe("m");
  });
});

describe("a tool call the server holds back until it's complete", () => {
  it("shows 'Preparing a tool call' with the tokens produced so far, not a frozen 'Thinking'", () => {
    const drafting = (tokens: number): NewEvent =>
      ({ ...base, kind: "tool.drafting", tokens }) as NewEvent;
    const s = run([
      [request("high"), 1_000],
      [reasoning("plan the file"), 2_000],
      [drafting(1), 3_000],
      [drafting(480), 13_000],
    ]);
    expect(s.status.activity?.verb).toBe("Preparing a tool call");
    expect(streamStats("Preparing a tool call", s.status.stream, 13_000)).toMatch(/^↓ 48\d tok/);
  });
});
