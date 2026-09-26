import { describe, expect, it } from "vitest";
import { ChatChunkSchema, ChatRequestSchema } from "../src/index.js";

describe("ChatRequestSchema", () => {
  it("accepts a well-formed streamed request", () => {
    const r = ChatRequestSchema.parse({
      model: "moonshotai/kimi-k2.7-code",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 2048,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(r.model).toBe("moonshotai/kimi-k2.7-code");
    expect(r.messages).toHaveLength(2);
  });
  it("rejects an empty model", () => {
    expect(() => ChatRequestSchema.parse({ model: "", messages: [] })).toThrow();
  });
});

describe("ChatChunkSchema", () => {
  it("validates a fragmented tool-call chunk", () => {
    const parsed = ChatChunkSchema.safeParse({
      model: "z-ai/glm-5.2",
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "call_1", function: { arguments: '{"a' } }] } },
      ],
    });
    expect(parsed.success).toBe(true);
  });
  it("validates a usage-only terminal chunk", () => {
    expect(ChatChunkSchema.safeParse({ choices: [], usage: { prompt_tokens: 1 } }).success).toBe(
      true,
    );
  });
});
