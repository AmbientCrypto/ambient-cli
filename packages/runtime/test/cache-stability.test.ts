import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { FixtureClient, TEXT_200K, catalogOf, memWorkspace, runOpts } from "./fixtures/catalog.js";

describe("prompt-cache-friendly requests", () => {
  it("the git snapshot rides with the task message, not the system prompt", async () => {
    let branch = "main · 1 changed";
    const ws = { ...memWorkspace(), git: () => branch };
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      { content: "ok", toolCalls: [] },
      { content: "ok", toolCalls: [] },
    ]);
    const first = await new Agent(client).run(
      "task one",
      runOpts({ requestedModel: TEXT_200K.id, workspace: ws }),
    );
    branch = "main · 5 changed"; // the repository changed between messages
    await new Agent(client).run(
      "task two",
      runOpts({
        requestedModel: TEXT_200K.id,
        workspace: ws,
        priorMessages: first.messages?.slice(1) ?? [],
      }),
    );
    const [a, b] = client.calls;
    expect(String(a?.messages[0]?.content)).not.toContain("changed");
    expect(String(b?.messages[0]?.content)).toBe(String(a?.messages[0]?.content)); // identical system prompt
    const task = b?.messages.find((m) => m.pinned);
    expect(String(task?.content)).toContain("main · 5 changed");
  });
});
