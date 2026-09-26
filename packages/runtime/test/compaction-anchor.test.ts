import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { Msg } from "../src/ports.js";
import { FixtureClient, VISION_32K, catalogOf, runOpts } from "./fixtures/catalog.js";

const filler = (n: number): Msg[] =>
  Array.from({ length: n }, (_, i) => [
    { role: "user" as const, content: `old request ${i} ${"y".repeat(3000)}` },
    { role: "assistant" as const, content: `old answer ${i} ${"z".repeat(3000)}` },
  ]).flat();

describe("compaction keeps the CURRENT task pinned in a long multi-message session", () => {
  it("the current request survives compaction; the first-ever request does not stay pinned", async () => {
    // ~30 prior turns of 6KB each overflow a 32K window → the run must compact before its first request.
    const prior: Msg[] = [
      { role: "user", content: `FIRST-EVER ${"q".repeat(3000)}` },
      ...filler(15),
    ];
    const client = new FixtureClient(catalogOf(VISION_32K), [
      { content: "summary of the old stuff", toolCalls: [] },
      { content: "done", toolCalls: [] },
      { content: "done", toolCalls: [] },
    ]);
    await new Agent(client).run(
      "CURRENT-REQUEST please fix the parser",
      runOpts({ requestedModel: VISION_32K.id, priorMessages: prior }),
    );
    const last = client.calls.at(-1)?.messages ?? [];
    const texts = last.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((t) => t.startsWith("CURRENT-REQUEST"))).toBe(true);
    expect(texts.some((t) => t.startsWith("FIRST-EVER"))).toBe(false);
    // No pinned flag ever reaches the wire-level message list the adapter serializes from.
    expect(last.every((m) => !("pinned" in m) || m.role === "user")).toBe(true);
  });
});
