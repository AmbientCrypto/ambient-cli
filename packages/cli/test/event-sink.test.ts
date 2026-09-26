import type { NewEvent } from "@amb/protocol";
import type { SessionWriter } from "@amb/sessions";
import { describe, expect, it } from "vitest";
import { createDurableEventSink } from "../src/agent/event-sink.js";

const ev: NewEvent = {
  kind: "turn.started",
  schemaVersion: 1,
  sessionId: "ses_x",
  turnId: "trn_x",
  input: "hi",
};

function fakeWriter(append: (e: NewEvent) => void): SessionWriter {
  return { append } as unknown as SessionWriter;
}

describe("createDurableEventSink (one durable pipeline)", () => {
  it("persists FIRST, then delivers to the consumer (order matters)", () => {
    const order: string[] = [];
    const sink = createDurableEventSink({
      writer: fakeWriter(() => order.push("persist")),
      consume: () => order.push("consume"),
      onWriteError: () => order.push("error"),
    });
    sink(ev);
    expect(order).toEqual(["persist", "consume"]);
  });

  it("on a write failure: calls onWriteError and does NOT deliver the event", () => {
    let consumed = false;
    let errored: Error | undefined;
    const sink = createDurableEventSink({
      writer: fakeWriter(() => {
        throw new Error("disk full");
      }),
      consume: () => {
        consumed = true;
      },
      onWriteError: (e) => {
        errored = e;
      },
    });
    sink(ev);
    expect(consumed).toBe(false); // never shown a UI event we couldn't log
    expect(errored?.message).toBe("disk full");
  });
});
