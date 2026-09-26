import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { FixtureClient, TEXT_200K, catalogOf, runOpts } from "./fixtures/catalog.js";

describe("a final answer cut off at the output limit", () => {
  it("is continued and stitched instead of being accepted as complete", async () => {
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      { content: "Here is the plan: step one, step", toolCalls: [], finishReason: "length" },
      { content: " two, step three.", toolCalls: [], finishReason: "stop" },
    ]);
    const res = await new Agent(client).run(
      "write a plan",
      runOpts({ requestedModel: TEXT_200K.id }),
    );
    expect(res.stopReason).toBe("complete");
    expect(res.finalText).toBe("Here is the plan: step one, step two, step three.");
    const ask = client.calls[1]?.messages.at(-1);
    expect(ask?.role).toBe("user");
    expect(String(ask?.content)).toMatch(/cut off/i);
  });

  it("stops continuing after a bound (a model that always hits the limit can't loop forever)", async () => {
    const cut = { content: "more", toolCalls: [], finishReason: "length" as const };
    const client = new FixtureClient(catalogOf(TEXT_200K), [cut, cut, cut, cut, cut, cut]);
    const res = await new Agent(client).run(
      "go",
      runOpts({ requestedModel: TEXT_200K.id, maxTurns: 10 }),
    );
    expect(client.calls.length).toBeLessThanOrEqual(3);
    expect(res.finalText.startsWith("more")).toBe(true);
  });
});

describe("the stitched prefix never leaks into a later answer", () => {
  it("cut-off → tool turn → final answer returns ONLY the final answer", async () => {
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      { content: "PARTIAL-A cut", toolCalls: [], finishReason: "length" },
      {
        content: "",
        toolCalls: [{ id: "tc1", name: "list", args: { path: "." }, rawArgs: "{}" }],
        finishReason: "tool_calls",
      },
      { content: "FINAL-ANSWER", toolCalls: [], finishReason: "stop" },
    ]);
    const res = await new Agent(client).run("go", runOpts({ requestedModel: TEXT_200K.id }));
    expect(res.finalText).toBe("FINAL-ANSWER");
  });
});
