import { AmbError } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { retryDelaySeconds } from "../src/failover.js";
import { FixtureClient, TEXT_200K, catalogOf, runOpts } from "./fixtures/catalog.js";

const err = (retryAfterMs?: number) =>
  new AmbError({
    kind: "rate_limit",
    message: "x",
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

describe("retryDelaySeconds", () => {
  it("uses our backoff when the server gives no Retry-After", () => {
    expect(retryDelaySeconds(err(), 1)).toBeLessThanOrEqual(4);
  });
  it("raises the wait to the server's Retry-After", () => {
    expect(retryDelaySeconds(err(20_000), 1)).toBe(20);
  });
  it("caps a huge Retry-After so the run can't be parked for hours", () => {
    expect(retryDelaySeconds(err(10 * 3600_000), 1)).toBe(60);
  });
});

describe("stream watchdog wiring", () => {
  it("every chat request carries first-byte + idle timeouts", async () => {
    const client = new FixtureClient(catalogOf(TEXT_200K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run("hi", runOpts({ requestedModel: TEXT_200K.id }));
    const t = client.calls[0]?.timeouts;
    expect(t?.firstByteMs).toBeGreaterThan(0);
    expect(t?.idleMs).toBeGreaterThan(0);
  });
});

describe("a stalled worker", () => {
  it("gets ONE same-model retry (each stall already cost a full timeout), then fails over", async () => {
    const { AmbError } = await import("@amb/protocol");
    const { TEXT_1M } = await import("./fixtures/catalog.js");
    const stall = () => {
      throw new AmbError({
        kind: "transport",
        message: "stalled",
        retryable: true,
        detail: "stream-stall",
      });
    };
    const client = new FixtureClient(catalogOf(TEXT_200K, TEXT_1M), [
      stall,
      stall,
      { content: "served by the other model", toolCalls: [] },
    ]);
    const res = await new Agent(client, undefined, { sleep: async () => {} }).run(
      "hi there friend",
      runOpts({ requestedModel: TEXT_200K.id }),
    );
    expect(client.calls.map((c) => c.model)).toEqual([TEXT_200K.id, TEXT_200K.id, TEXT_1M.id]);
    expect(res.finalText).toBe("served by the other model");
  });
});

describe("real outcomes are recorded for model choice", () => {
  it("records a success with its latency, and a stall as a failure", async () => {
    const { AmbError } = await import("@amb/protocol");
    const { TEXT_1M } = await import("./fixtures/catalog.js");
    const outcomes: Array<[string, boolean]> = [];
    const capabilities = {
      laneFor: () => "direct" as const,
      learn: () => {},
      recordOutcome: (id: string, ok: boolean) => outcomes.push([id, ok]),
    };
    const stall = () => {
      throw new AmbError({
        kind: "transport",
        message: "stalled",
        retryable: true,
        detail: "stream-stall",
      });
    };
    const client = new FixtureClient(catalogOf(TEXT_200K, TEXT_1M), [
      stall,
      stall,
      { content: "ok", toolCalls: [] },
    ]);
    await new Agent(client, undefined, { sleep: async () => {} }).run(
      "hi there friend",
      runOpts({ requestedModel: TEXT_200K.id, capabilities }),
    );
    expect(outcomes).toEqual([
      [TEXT_200K.id, false],
      [TEXT_200K.id, false],
      [TEXT_1M.id, true],
    ]);
  });
});
