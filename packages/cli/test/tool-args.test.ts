import { describe, expect, it } from "vitest";
import { parseToolArgs } from "../src/agent/ambient-client.js";

describe("parseToolArgs", () => {
  it("treats empty/whitespace arguments as an empty object (a zero-arg call is valid)", () => {
    expect(parseToolArgs("")).toEqual({});
    expect(parseToolArgs("  \n")).toEqual({});
  });
  it("parses JSON and returns undefined only for genuinely malformed input", () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs("{bad")).toBeUndefined();
  });
});

describe("wire messages", () => {
  it("echo a zero-arg call's arguments as '{}' and never serialize the pinned flag", async () => {
    const { toWireMessages } = await import("../src/agent/ambient-client.js");
    const wire = toWireMessages([
      { role: "user", content: "task", pinned: true },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a", name: "list", args: {}, rawArgs: "" }],
      },
    ]) as Array<Record<string, unknown>>;
    expect(JSON.stringify(wire)).not.toContain("pinned");
    const call = (wire[1]?.tool_calls as Array<{ function: { arguments: string } }>)[0];
    expect(call?.function.arguments).toBe("{}");
  });
});
