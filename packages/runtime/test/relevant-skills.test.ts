import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { FixtureClient, TEXT_200K, catalogOf, memWorkspace, runOpts } from "./fixtures/catalog.js";

describe("skills relevant to the task", () => {
  it("ride with the task message; the system prompt is the same for every task", async () => {
    const workspace = {
      ...memWorkspace(),
      skills: () => [
        {
          name: "deploy-staging",
          description: "Deploy the app to staging with checks",
          path: "/s/a",
        },
        { name: "write-tests", description: "Write unit tests", path: "/s/b" },
      ],
    };
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      { content: "ok", toolCalls: [] },
      { content: "ok", toolCalls: [] },
    ]);
    await new Agent(client).run(
      "deploy this to staging",
      runOpts({ requestedModel: TEXT_200K.id, workspace }),
    );
    await new Agent(client).run(
      "what time is it",
      runOpts({ requestedModel: TEXT_200K.id, workspace }),
    );
    const [a, b] = client.calls;
    expect(String(a?.messages.at(-1)?.content)).toContain(
      "deploy-staging: Deploy the app to staging",
    );
    expect(String(b?.messages.at(-1)?.content)).not.toContain("skills_that_may_help");
    expect(a?.messages[0]?.content).toBe(b?.messages[0]?.content);
  });
});
