import { describe, expect, it } from "vitest";
import type { Msg } from "../src/ports.js";
import { wireMessages } from "../src/wire-messages.js";

describe("system messages only at the start", () => {
  it("keeps leading system messages, turns later ones into a note in a user turn", () => {
    const out = wireMessages([
      { role: "system", content: "base" },
      { role: "user", content: "task" },
      { role: "assistant", content: "ok" },
      { role: "system", content: "Summary of earlier work" },
      { role: "user", content: "next" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(out[3]?.content).toBe(
      "<ambient-note>\nSummary of earlier work\n</ambient-note>\n\nnext",
    );
  });
  it("a trailing note (the plan) joins the last user message; after an answer it's its own user turn", () => {
    const joined = wireMessages([
      { role: "system", content: "base" },
      { role: "user", content: "task" },
      { role: "system", content: "Plan: 1. read" },
    ]);
    expect(joined.map((m) => m.role)).toEqual(["system", "user"]);
    expect(String(joined[1]?.content)).toContain("Plan: 1. read");
    const own = wireMessages([
      { role: "system", content: "base" },
      { role: "user", content: "task" },
      { role: "assistant", content: "done" },
      { role: "system", content: "Plan" },
    ]);
    expect(own.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
  it("never lands between a tool call and its results", () => {
    const call: Msg = {
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "a", name: "read", args: {}, rawArgs: "{}" },
        { id: "b", name: "read", args: {}, rawArgs: "{}" },
      ],
    };
    const out = wireMessages([
      { role: "system", content: "base" },
      { role: "user", content: "task" },
      call,
      { role: "system", content: "note" },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "tool", toolCallId: "b", content: "B" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
  });
  it("keeps image parts when a note joins a user message", () => {
    const out = wireMessages([
      { role: "system", content: "base" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] },
      { role: "system", content: "note" },
    ]);
    expect(out[1]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "<ambient-note>\nnote\n</ambient-note>" },
    ]);
  });

  it("merges several leading system messages into one (some templates allow only one)", () => {
    const out = wireMessages([
      { role: "system", content: "base" },
      { role: "system", content: "Summary of earlier work" },
      { role: "user", content: "next" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out[0]?.content).toBe("base\n\nSummary of earlier work");
  });
});
