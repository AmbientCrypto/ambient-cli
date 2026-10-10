import type { NewEvent } from "@amb/protocol";
import { expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { ChatClient } from "../src/ports.js";
import { TEXT_200K, catalogOf, runOpts } from "./fixtures/catalog.js";

it.each([false, true])(
  "discards an aborted response even when the provider finishes (whole cancel: %s)",
  async (wholeCancel) => {
    const cancel = new AbortController();
    let interrupt = new AbortController();
    let queued: string[] = [];
    let requests = 0;
    let events: NewEvent[] = [];
    const client: ChatClient = {
      fetchCatalog: async () => catalogOf(TEXT_200K),
      chat: async (params) => {
        requests++;
        if (requests === 1) {
          queued = ["change direction"];
          interrupt.abort();
          if (wholeCancel) cancel.abort();
          return {
            content: "stale",
            toolCalls: [
              {
                id: "stale",
                name: "bash",
                args: { command: "exit 9" },
                rawArgs: '{"command":"exit 9"}',
              },
            ],
          };
        }
        expect(JSON.stringify(params.messages)).toContain("change direction");
        expect(JSON.stringify(params.messages)).not.toContain("stale");
        return { content: "redirected", toolCalls: [] };
      },
    };
    const result = await new Agent(client).run(
      "original",
      runOpts({
        requestedModel: TEXT_200K.id,
        maxTurns: 1,
        signal: cancel.signal,
        steerSignal: () => interrupt.signal,
        steer: () => {
          const ready = queued;
          queued = [];
          interrupt = new AbortController();
          return ready;
        },
        emit: (ev) => {
          events = [...events, ev];
        },
      }),
    );
    expect(result.stopReason).toBe(wholeCancel ? "cancelled" : "max_turns");
    expect(requests).toBe(wholeCancel ? 1 : 2);
    if (!wholeCancel) expect(result.finalText).toBe("redirected");
    expect(result.turns).toBe(1);
    expect(events.some((ev) => ev.kind === "tool.started")).toBe(false);
    expect(
      events.filter((ev) => ev.kind === "operation.cancelled" && ev.scope === "stream"),
    ).toHaveLength(wholeCancel ? 0 : 1);
  },
);

it("finishes an active tool and keeps its result paired before reading steering", async () => {
  let interrupt = new AbortController();
  let queued: string[] = [];
  let events: NewEvent[] = [];
  let requests = 0;
  const command = `node -e "process.stdout.write('tool completed')"`;
  const client: ChatClient = {
    fetchCatalog: async () => catalogOf(TEXT_200K),
    chat: async (params) => {
      requests++;
      if (requests === 1)
        return {
          content: "",
          toolCalls: [
            {
              id: "running",
              name: "bash",
              args: { command },
              rawArgs: JSON.stringify({ command }),
            },
          ],
        };
      expect(JSON.stringify(params.messages)).toContain("change direction");
      expect(JSON.stringify(params.messages)).toContain("tool completed");
      return { content: "redirected", toolCalls: [] };
    },
  };
  const result = await new Agent(client).run(
    "original",
    runOpts({
      requestedModel: TEXT_200K.id,
      maxTurns: 4,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      steerSignal: () => interrupt.signal,
      steer: () => {
        const ready = queued;
        queued = [];
        interrupt = new AbortController();
        return ready;
      },
      emit: (ev) => {
        events = [...events, ev];
        if (ev.kind === "tool.started") {
          queued = ["change direction"];
          interrupt.abort();
        }
      },
    }),
  );
  expect(result.stopReason).toBe("complete");
  expect(requests).toBe(2);
  expect(events.find((ev) => ev.kind === "tool.result")).toMatchObject({ ok: true });
  expect(events.findIndex((ev) => ev.kind === "tool.result")).toBeLessThan(
    events.findIndex((ev) => ev.kind === "steer"),
  );
});
