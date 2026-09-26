import { describe, expect, it } from "vitest";
import { type ChatRequest, buildChatBody } from "../src/index.js";

const base: ChatRequest = { model: "z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }] };

describe("buildChatBody", () => {
  it("always streams with usage included (the Ambient contract)", () => {
    const body = buildChatBody(base);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe("z-ai/glm-5.2");
  });

  it("includes reasoning_effort ONLY when the caller set it", () => {
    expect(buildChatBody(base).reasoning_effort).toBeUndefined();
    expect(buildChatBody({ ...base, reasoningEffort: "high" }).reasoning_effort).toBe("high");
    expect(buildChatBody({ ...base, reasoningEffort: "none" }).reasoning_effort).toBe("none");
    expect(buildChatBody({ ...base, reasoningEffort: "max" }).reasoning_effort).toBe("max");
  });

  it("omits an empty tools array (some models reject it) but keeps a non-empty one", () => {
    expect(buildChatBody({ ...base, tools: [] }).tools).toBeUndefined();
    const withTool = buildChatBody({ ...base, tools: [{ type: "function" }] });
    expect(Array.isArray(withTool.tools)).toBe(true);
  });
});
