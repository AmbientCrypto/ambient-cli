import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { FixtureClient, TEXT_200K, catalogOf, runOpts } from "./fixtures/catalog.js";

const bad = (n: number) => ({
  content: "",
  toolCalls: [{ id: `tc_${n}`, name: "list", args: undefined, rawArgs: '{"path": ' }],
});

describe("tool-lane learning", () => {
  it("demotes only after repeated malformed native calls in a run", async () => {
    const learned: Array<[string, boolean]> = [];
    const capabilities = {
      laneFor: () => "direct" as const,
      learn: (id: string, w: boolean) => learned.push([id, w]),
    };
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      bad(1),
      bad(2),
      bad(3),
      { content: "done", toolCalls: [] },
    ]);
    await new Agent(client).run(
      "go",
      runOpts({ requestedModel: TEXT_200K.id, capabilities, maxTurns: 6 }),
    );
    expect(learned).toEqual([[TEXT_200K.id, false]]);
  });

  it("a malformed call gets a specific repair hint quoting the raw arguments", async () => {
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      bad(1),
      { content: "done", toolCalls: [] },
    ]);
    await new Agent(client).run("go", runOpts({ requestedModel: TEXT_200K.id }));
    const toolMsg = client.calls[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toMatch(/not valid JSON/i);
    expect(String(toolMsg?.content)).toContain('{"path": ');
  });
});
