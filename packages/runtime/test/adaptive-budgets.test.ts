import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import {
  FixtureClient,
  TEXT_1M,
  VISION_32K,
  catalogOf,
  memWorkspace,
  runOpts,
} from "./fixtures/catalog.js";

async function runOn(model: typeof TEXT_1M) {
  const limits: Array<{ perFile: number; total: number } | undefined> = [];
  const ws = memWorkspace();
  const client = new FixtureClient(catalogOf(model), [{ content: "ok", toolCalls: [] }]);
  await new Agent(client).run(
    "build it",
    runOpts({
      requestedModel: model.id,
      workspace: {
        ...ws,
        instructions: (_cwd, l) => {
          limits.push(l);
          return "";
        },
      },
    }),
  );
  return { request: client.calls[0], limits: limits[0] };
}

describe("budgets come from the served model's catalog entry", () => {
  it("a 1M-context model asks for more output and allows bigger instruction files than a 32K one", async () => {
    const small = await runOn(VISION_32K);
    const huge = await runOn(TEXT_1M);
    expect(huge.request?.maxTokens ?? 0).toBeGreaterThan(small.request?.maxTokens ?? 0);
    expect(huge.request?.maxTokens ?? 0).toBeGreaterThan(8192); // no fixed 8192 ceiling
    expect(huge.limits?.perFile ?? 0).toBeGreaterThan(small.limits?.perFile ?? 0);
    expect(huge.limits?.total ?? 0).toBeGreaterThan(small.limits?.total ?? 0);
  });
  it("the output request never exceeds the model's published output cap", async () => {
    const small = await runOn(VISION_32K); // max_output_length 8192
    expect(small.request?.maxTokens ?? 0).toBeLessThanOrEqual(8192);
  });
});
