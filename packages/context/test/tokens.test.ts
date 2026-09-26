import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_TOKENS, estimateMessagesTokens, estimateTokens } from "../src/tokens.js";

describe("image-aware token estimation", () => {
  it("counts an image content-part as a fixed cost, NOT its (huge) base64 length", () => {
    const bigBase64 = "A".repeat(500_000); // ~500KB base64 → ~143k tokens if counted as text
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this screenshot?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${bigBase64}` } },
        ],
      },
    ];
    const tokens = estimateMessagesTokens(messages);
    // text (~7) + one image (DEFAULT_IMAGE_TOKENS) + role + overhead — nowhere near the 140k+ a base64 count gives.
    expect(tokens).toBeLessThan(DEFAULT_IMAGE_TOKENS + 100);
    expect(tokens).toBeGreaterThan(DEFAULT_IMAGE_TOKENS - 1);
  });

  it("honors a per-image resolver (sized from the served model)", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
      },
    ];
    expect(estimateMessagesTokens(messages, { imageTokens: () => 300 })).toBeLessThan(320);
  });

  it("string content is unchanged", () => {
    const t = estimateMessagesTokens([{ role: "user", content: "hello world" }]);
    expect(t).toBe(estimateTokens("hello world") + estimateTokens("user") + 4);
  });
});
