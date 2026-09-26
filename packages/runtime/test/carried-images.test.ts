import { describe, expect, it } from "vitest";
import { stubCarriedImages } from "../src/agent-support.js";
import { Agent } from "../src/agent.js";
import type { Msg } from "../src/ports.js";
import { FixtureClient, TEXT_200K, catalogOf, runOpts } from "./fixtures/catalog.js";

const img = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const prior: Msg[] = [
  { role: "user", content: [{ type: "text", text: "what is in this?" }, img, img] },
  { role: "assistant", content: "A cat and a dog." },
];

const hasImagePart = (msgs: Msg[]) =>
  msgs.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => (p as { type?: string }).type === "image_url"),
  );

describe("carried images", () => {
  it("replaces earlier image parts with numbered text stubs (keeps the text)", () => {
    const out = stubCarriedImages(prior);
    expect(hasImagePart(out)).toBe(false);
    expect(out[0]?.content).toBe(
      "what is in this?\n[image #1 from an earlier message — not re-sent]\n[image #2 from an earlier message — not re-sent]",
    );
    expect(out[1]).toEqual(prior[1]);
  });

  it("a follow-up run to a BLIND model never re-sends earlier image parts (no 400)", async () => {
    const client = new FixtureClient(catalogOf(TEXT_200K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "and the dog's color?",
      runOpts({ requestedModel: TEXT_200K.id, priorMessages: prior }),
    );
    expect(hasImagePart(client.calls[0]?.messages ?? [])).toBe(false);
  });
});

describe("pinned flag on carried history", () => {
  it("an earlier run's pinned task is un-pinned when carried (only the CURRENT task is pinned)", () => {
    const out = stubCarriedImages([{ role: "user", content: "old task", pinned: true }]);
    expect(out[0]?.pinned).toBeUndefined();
  });
  it("in a follow-up run exactly one message — the new task — is pinned", async () => {
    const client = new FixtureClient(catalogOf(TEXT_200K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "new task",
      runOpts({
        requestedModel: TEXT_200K.id,
        priorMessages: [
          { role: "user", content: "old task", pinned: true },
          { role: "assistant", content: "done" },
        ],
      }),
    );
    const pinned = (client.calls[0]?.messages ?? []).filter((m) => m.pinned);
    expect(pinned.map((m) => m.content)).toEqual(["new task"]);
  });
});
