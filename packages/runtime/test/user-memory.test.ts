import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { FixtureClient, TEXT_200K, catalogOf, memWorkspace, runOpts } from "./fixtures/catalog.js";

describe("memory in the prompt", () => {
  it("carries the user's every-project notes alongside the project's", async () => {
    const ws = {
      ...memWorkspace(),
      memory: "## Notes (curated by the agent — durable across sessions)\n- deploy with make ship",
      readUserMemory: () => "- answer in British English",
    };
    ws.readMemory = () => ws.memory;
    const client = new FixtureClient(catalogOf(TEXT_200K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run("hi", runOpts({ requestedModel: TEXT_200K.id, workspace: ws }));
    const system = String(client.calls[0]?.messages[0]?.content);
    expect(system).toContain("## Your notes (kept for every project)\n- answer in British English");
    expect(system).toContain("deploy with make ship");
  });
});
