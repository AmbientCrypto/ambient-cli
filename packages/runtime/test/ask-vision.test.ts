import type { CatalogModel, ImageAttachment, ToolContext } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { makeAskVisionTool } from "../src/ask-vision.js";
import type { ChatClient, ChatParams } from "../src/ports.js";

const vl: CatalogModel = {
  id: "q/vl",
  name: "q",
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  supportedFeatures: ["tools"],
  supportedSamplingParameters: [],
  contextLength: 32_768,
  maxOutputLength: 8_192,
  isReady: true,
};
const img = (id: string): ImageAttachment => ({
  id,
  mediaType: "image/png",
  dataBase64: `B64-${id}`,
  bytes: 4,
  sha256: id,
  source: "file",
});
const ctx = { signal: new AbortController().signal } as unknown as ToolContext;

describe("ask_vision", () => {
  it("sends the chosen image and the question to a vision model and returns its answer", async () => {
    let sent: ChatParams | undefined;
    const client = {
      fetchCatalog: async () => [vl],
      chat: async (p: ChatParams) => {
        sent = p;
        return { content: "The error says: ENOSPC", toolCalls: [] };
      },
    } as ChatClient;
    const tool = makeAskVisionTool({
      client,
      catalog: () => [vl],
      images: () => [img("a"), img("b")],
      targetWindow: () => 202_752,
    });
    const out = await tool.execute({ image: 2, question: "what does the red text say?" }, ctx);
    expect(out.answer).toContain("ENOSPC");
    expect(out.visionModel).toBe("q/vl");
    const parts = sent?.messages[0]?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toContain("B64-b");
    expect(parts[0]?.text).toContain("what does the red text say?");
  });

  it("is honest about an image number that doesn't exist, and about no vision model", async () => {
    const client = {
      fetchCatalog: async () => [],
      chat: async () => ({ content: "x", toolCalls: [] }),
    } as ChatClient;
    const tool = makeAskVisionTool({
      client,
      catalog: () => [],
      images: () => [img("a")],
      targetWindow: () => 32_768,
    });
    await expect(tool.execute({ image: 3, question: "?" }, ctx)).rejects.toThrow(
      /no image #3 — this session has 1 image/,
    );
    await expect(tool.execute({ image: 1, question: "?" }, ctx)).rejects.toThrow(
      /no vision-capable model/,
    );
  });
});
