import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { SUMMARY_MARKER } from "../src/agent-support.js";
import { compact } from "../src/compaction-runner.js";
import type { ChatClient, ChatParams, Msg, TurnCompletion } from "../src/ports.js";

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 8_000,
    maxOutputLength: 8_000,
    isReady: true,
  };
}

class MockClient implements ChatClient {
  public calls: ChatParams[] = [];
  constructor(private readonly reply: TurnCompletion) {}
  async fetchCatalog(): Promise<CatalogModel[]> {
    return [model("vendor/m")];
  }
  async chat(params: ChatParams): Promise<TurnCompletion> {
    this.calls.push(params);
    return this.reply;
  }
}

/** A conversation big enough (well past the recent-retention floor) that planCompaction has a real middle to
 *  summarize — so compact() actually produces a summary instead of a no-op. */
function longConversation(): Msg[] {
  const msgs: Msg[] = [
    { role: "system", content: "SYSTEM ANCHOR (goal + pinned plan)" },
    { role: "user", content: "the original task" },
  ];
  for (let i = 0; i < 60; i++) {
    msgs.push({
      role: i % 2 === 0 ? "assistant" : "user",
      content: `turn ${i}: ${"context words to fill tokens ".repeat(60)}`,
    });
  }
  return msgs;
}

describe("compaction re-orientation (plan recalibration after a compaction)", () => {
  it("the summary message tells the model to re-read the pinned plan and continue from the next step", async () => {
    const client = new MockClient({
      content: "## Goal\nship it\n## Progress\ndid A",
      toolCalls: [],
    });
    const out = await compact(
      client,
      longConversation(),
      "vendor/m",
      [model("vendor/m")],
      "ses_c-0000",
      "trn_c-0000",
      () => {},
      new AbortController().signal,
      () => {},
      4_000, // small window → real compaction
      "",
    );
    expect(out).not.toBeNull();
    const summaryMsg = (out ?? []).find(
      (m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_MARKER),
    );
    expect(summaryMsg).toBeDefined();
    const body = String(summaryMsg?.content);
    // Recalibration instruction — where it left off + how to continue cleanly.
    expect(body).toContain("CONTINUE FROM THE NEXT UNFINISHED STEP");
    expect(body).toContain("pinned plan");
    expect(body).toContain("`plan` tool"); // keep the plan current (mark finished steps done)
    // and it still carries the actual summary content.
    expect(body).toContain("ship it");
  });
});
