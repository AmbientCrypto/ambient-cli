import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { clearRelayCache } from "../src/vision-relay.js";
import { FixtureClient, TEXT_200K, VISION_32K, catalogOf, runOpts } from "./fixtures/catalog.js";

const png = {
  id: "i1",
  mediaType: "image/png" as const,
  dataBase64: "iVBORw0KGgo=",
  bytes: 8,
  sha256: "h1",
  source: "file" as const,
};

describe("ask_vision in a run", () => {
  it("a model that can't see images gets ask_vision and can ask a follow-up about the image", async () => {
    clearRelayCache();
    const client = new FixtureClient(catalogOf(TEXT_200K, VISION_32K), [
      { content: "A dialog with an error message.", toolCalls: [] }, // the initial relay description
      {
        content: "",
        toolCalls: [
          {
            id: "av1",
            name: "ask_vision",
            args: { image: 1, question: "exact error code?" },
            rawArgs: "{}",
          },
        ],
      },
      { content: "ERR-4172", toolCalls: [] }, // the vision model answers the follow-up
      { content: "The error code is ERR-4172.", toolCalls: [] },
    ]);
    const res = await new Agent(client).run(
      "what's the error code?",
      runOpts({ requestedModel: TEXT_200K.id, attachments: [png] }),
    );
    const served = client.calls.filter((c) => c.model === TEXT_200K.id);
    expect(
      served[0]?.tools.some(
        (t) => (t as { function?: { name?: string } }).function?.name === "ask_vision",
      ),
    ).toBe(true);
    const followUp = client.calls.find(
      (c) => c.model === VISION_32K.id && JSON.stringify(c.messages).includes("exact error code?"),
    );
    expect(followUp).toBeDefined();
    expect(res.finalText).toContain("ERR-4172");
  });

  it("a model that CAN see images does not get ask_vision", async () => {
    const client = new FixtureClient(catalogOf(VISION_32K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "look",
      runOpts({ requestedModel: VISION_32K.id, attachments: [png] }),
    );
    expect(
      client.calls[0]?.tools.some(
        (t) => (t as { function?: { name?: string } }).function?.name === "ask_vision",
      ),
    ).toBe(false);
  });
});
