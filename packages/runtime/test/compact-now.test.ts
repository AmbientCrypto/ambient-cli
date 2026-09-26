import { describe, expect, it } from "vitest";
import { compactConversation } from "../src/index.js";
import type { Msg } from "../src/ports.js";
import { FixtureClient, TEXT_200K, catalogOf } from "./fixtures/catalog.js";

/** A short session — far below what automatic compaction would ever touch on a 200K model. */
const session = (): Msg[] => [
  { role: "system", content: "rules" },
  ...Array.from({ length: 12 }, (_, i): Msg[] => [
    { role: "user", content: `step ${i}: ${"detail ".repeat(200)}` },
    { role: "assistant", content: `did step ${i} ${"done ".repeat(200)}` },
  ]).flat(),
];

const run = (
  client: FixtureClient,
  messages: Msg[],
  opts?: { keepRecentTokens?: number; focus?: string },
) =>
  compactConversation(
    client,
    messages,
    TEXT_200K.id,
    catalogOf(TEXT_200K),
    "ses_c",
    "trn_c",
    () => {},
    new AbortController().signal,
    () => {},
    200_000,
    "",
    opts,
  );

describe("compacting on request", () => {
  it("automatic settings leave a short session alone, a request compacts it", async () => {
    const auto = await run(new FixtureClient(catalogOf(TEXT_200K), []), session());
    expect(auto).toBeNull();
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      { content: "## Goal\nsteps\n## Progress\nall twelve", toolCalls: [] },
    ]);
    const next = await run(client, session(), {
      keepRecentTokens: 500,
      focus: "the parser changes",
    });
    expect(next).not.toBeNull();
    expect(next?.length).toBeLessThan(session().length);
    const instruction = String(client.calls[0]?.messages[0]?.content);
    expect(instruction).toContain("focus on: the parser changes");
  });
});

describe("compacting a carried conversation", () => {
  it("summarizes earlier tasks in order even though each was pinned in its own run", async () => {
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      { content: "## Goal\nall", toolCalls: [] },
    ]);
    const long = (s: string) => `${s} ${"words ".repeat(400)}`;
    const carried: Msg[] = [
      { role: "system", content: "" },
      { role: "user", content: long("task one"), pinned: true },
      { role: "assistant", content: long("answer one") },
      { role: "user", content: long("task two"), pinned: true },
      { role: "assistant", content: long("answer two") },
      { role: "user", content: "task three", pinned: true },
      { role: "assistant", content: "answer three" },
    ];
    const unpinned = carried.map((m) => (m.pinned ? { ...m, pinned: undefined } : m));
    const next = await run(client, unpinned, { keepRecentTokens: 50 });
    const order = (next ?? []).map((m) => `${m.role}:${String(m.content).slice(0, 12)}`);
    // System anchor, the summary, then the latest exchange — earlier tasks are inside the summary.
    expect(order.at(-2)).toBe("user:task three");
    expect(order.at(-1)).toBe("assistant:answer three");
    expect(order.some((o) => o.startsWith("user:task one"))).toBe(false);
    const sent = String(client.calls[0]?.messages.at(-1)?.content);
    expect(sent.indexOf("task one")).toBeLessThan(sent.indexOf("task two"));
  });
  it("a cancelled compaction changes nothing, not even project memory", async () => {
    const ac = new AbortController();
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      () => {
        ac.abort();
        throw new Error("aborted");
      },
    ]);
    let writes = 0;
    const next = await compactConversation(
      client,
      session(),
      TEXT_200K.id,
      catalogOf(TEXT_200K),
      "ses_c",
      "trn_c",
      () => {},
      ac.signal,
      () => {
        writes += 1;
      },
      200_000,
      "",
      { keepRecentTokens: 500 },
    );
    expect(next).toBeNull();
    expect(writes).toBe(0);
  });
});
