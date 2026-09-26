import { describe, expect, it } from "vitest";
import { SUMMARY_MARKER } from "../src/agent-support.js";
import { Agent } from "../src/agent.js";
import { FixtureClient, TEXT_200K, catalogOf, memWorkspace, runOpts } from "./fixtures/catalog.js";

const MEMORY = [
  "# Ambient memory",
  "",
  "AUTO-SUMMARY: we were refactoring the parser",
  "",
  "## Notes (curated by the agent — durable across sessions)",
  "- NOTE: tests run with pnpm test",
].join("\n");

describe("project memory in a carried session", () => {
  it("omits the auto-summary (already present as a carried summary message) but keeps curated notes", async () => {
    const ws = memWorkspace();
    ws.memory = MEMORY;
    const client = new FixtureClient(catalogOf(TEXT_200K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "next",
      runOpts({
        requestedModel: TEXT_200K.id,
        workspace: ws,
        priorMessages: [
          { role: "user", content: "earlier" },
          {
            role: "system",
            content: `${SUMMARY_MARKER}\nAUTO-SUMMARY: we were refactoring the parser`,
          },
        ],
      }),
    );
    const system = String(client.calls[0]?.messages[0]?.content);
    expect(system).toContain("NOTE: tests run with pnpm test");
    expect(system).not.toContain("AUTO-SUMMARY");
  });

  it("a fresh session still gets the full project memory", async () => {
    const ws = memWorkspace();
    ws.memory = MEMORY;
    const client = new FixtureClient(catalogOf(TEXT_200K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run("start", runOpts({ requestedModel: TEXT_200K.id, workspace: ws }));
    expect(String(client.calls[0]?.messages[0]?.content)).toContain("AUTO-SUMMARY");
  });
});

describe("a spill breadcrumb is not a summary", () => {
  it("keeps the project memory's auto-summary when the carried session only has a spill breadcrumb", async () => {
    const { SPILL_NOTE } = await import("../src/agent-support.js");
    const ws = memWorkspace();
    ws.memory = MEMORY;
    const client = new FixtureClient(catalogOf(TEXT_200K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "next",
      runOpts({
        requestedModel: TEXT_200K.id,
        workspace: ws,
        priorMessages: [
          { role: "user", content: "earlier" },
          { role: "system", content: `${SUMMARY_MARKER} — 12 earlier message(s) ${SPILL_NOTE}.` },
        ],
      }),
    );
    expect(String(client.calls[0]?.messages[0]?.content)).toContain("AUTO-SUMMARY");
  });
});
