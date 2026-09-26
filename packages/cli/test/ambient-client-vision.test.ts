import type { Msg } from "@amb/runtime";
import { describe, expect, it } from "vitest";
import { messagesHaveImageParts, toWireMessages } from "../src/agent/ambient-client.js";

const imgMsg: Msg = {
  role: "user",
  content: [
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ],
};

describe("wire vision pass-through", () => {
  it("passes a content-parts ARRAY through VERBATIM (does not collapse it to a JSON string)", () => {
    const wire = toWireMessages([imgMsg]) as { role: string; content: unknown }[];
    expect(Array.isArray(wire[0]?.content)).toBe(true); // the image part survives
    expect(wire[0]?.content).toEqual(imgMsg.content);
  });

  it("still stringifies a non-string, non-array content defensively", () => {
    const wire = toWireMessages([{ role: "user", content: { weird: 1 } }]) as {
      content: unknown;
    }[];
    expect(typeof wire[0]?.content).toBe("string");
  });

  it("keeps a plain string message a string", () => {
    const wire = toWireMessages([{ role: "user", content: "hello" }]) as { content: unknown }[];
    expect(wire[0]?.content).toBe("hello");
  });

  it("messagesHaveImageParts detects an image content-part (drives the overflow-exclusion)", () => {
    expect(messagesHaveImageParts([imgMsg])).toBe(true);
    expect(messagesHaveImageParts([{ role: "user", content: "just text" }])).toBe(false);
    expect(
      messagesHaveImageParts([{ role: "user", content: [{ type: "text", text: "no image" }] }]),
    ).toBe(false);
  });
});
