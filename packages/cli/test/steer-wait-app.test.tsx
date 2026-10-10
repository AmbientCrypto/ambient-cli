import type { CatalogModel, NewEvent } from "@amb/protocol";
import type { ChatClient, ChatParams } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import { App } from "../src/tui/App.js";

const model: CatalogModel = {
  id: "vendor/m",
  name: "m",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedFeatures: ["tools"],
  supportedSamplingParameters: [],
  contextLength: 128_000,
  maxOutputLength: 8192,
  isReady: true,
};
const waitFor = async (fn: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("steering did not reach the running agent");
    await new Promise((r) => setTimeout(r, 20));
  }
};

it.each(["\r", "\n", "\x1bOM"])(
  "a second Enter %j interrupts streaming and consumes queued steering in the same run",
  async (enter) => {
    let requests = 0;
    let interrupted = false;
    let events: NewEvent[] = [];
    const client: ChatClient = {
      fetchCatalog: async () => [model],
      chat: async (params) => {
        requests++;
        if (requests === 1) {
          params.onReasoning?.("Thinking about the original task");
          params.onContent?.("An unfinished answer");
          return await new Promise((_, reject) => {
            params.signal.addEventListener(
              "abort",
              () => {
                interrupted = true;
                reject(new Error("stream aborted"));
              },
              { once: true },
            );
          });
        }
        expect(JSON.stringify(params.messages)).toContain("check failure first");
        return { content: "STEER DELIVERED", toolCalls: [] };
      },
    };
    const ui = render(
      <App
        client={client}
        makeWriter={() =>
          ({
            append: (ev: NewEvent) => {
              events = [...events, ev];
            },
            close() {},
            path: "/dev/null",
          }) as unknown as SessionWriter
        }
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={1}
        cwd={process.cwd()}
        workspaceRoot={process.cwd()}
      />,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      for (const c of "build") ui.stdin.write(c);
      ui.stdin.write(enter);
      await waitFor(() => requests === 1);
      for (const c of "check failure first") ui.stdin.write(c);
      ui.stdin.write(enter);
      await waitFor(() => events.some((ev) => ev.kind === "steer.queued"));
      expect(interrupted).toBe(false);
      ui.stdin.write(enter);
      await waitFor(() => events.some((ev) => ev.kind === "turn.finished"));
      expect(interrupted).toBe(true);
      expect(requests).toBe(2);
      const receipt = events.find((ev) => ev.kind === "steer.queued");
      const consumed = events.find((ev) => ev.kind === "steer");
      expect(consumed?.kind === "steer" ? consumed.messageId : undefined).toBe(
        receipt?.kind === "steer.queued" ? receipt.messageId : "missing",
      );
      expect(events.filter((ev) => ev.kind === "turn.started")).toHaveLength(1);
      expect(events.some((ev) => ev.kind === "steer.discarded")).toBe(false);
    } finally {
      ui.unmount();
    }
  },
);

it.each(["\r", "\n", "\x1bOM"])(
  "Enter %j durably accepts steering and wakes a quiet job",
  async (enter) => {
    let requests = 0;
    let delivered = false;
    let events: NewEvent[] = [];
    const client: ChatClient = {
      fetchCatalog: async () => [model],
      chat: async (params: ChatParams) => {
        requests++;
        const args =
          requests === 1
            ? { command: 'node -e "setInterval(() => {}, 1000)"', background: true }
            : { id: "bg1" };
        if (requests <= 2)
          return {
            content: "",
            toolCalls: [
              {
                id: `call_${requests}`,
                name: requests === 1 ? "bash" : "bash_wait",
                args,
                rawArgs: JSON.stringify(args),
              },
            ],
          };
        delivered = JSON.stringify(params.messages).includes("check failure first");
        return { content: "STEER DELIVERED", toolCalls: [] };
      },
    };
    const ui = render(
      <App
        client={client}
        makeWriter={() =>
          ({
            append: (ev: NewEvent) => {
              events = [...events, ev];
            },
            close() {},
            path: "/dev/null",
          }) as unknown as SessionWriter
        }
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={6}
        cwd={process.cwd()}
        workspaceRoot={process.cwd()}
      />,
    );
    try {
      await new Promise((r) => setTimeout(r, 30));
      for (const c of "build") ui.stdin.write(c);
      ui.stdin.write("\r");
      await waitFor(() => requests === 2);
      for (const c of "check failure first") ui.stdin.write(c);
      ui.stdin.write(enter);
      await waitFor(() => delivered);
      const receipt = events.find((ev) => ev.kind === "steer.queued");
      const consumed = events.find((ev) => ev.kind === "steer");
      expect(receipt?.kind === "steer.queued" ? receipt.messageId : undefined).toBeTruthy();
      expect(consumed?.kind === "steer" ? consumed.messageId : undefined).toBe(
        receipt?.kind === "steer.queued" ? receipt.messageId : "missing",
      );
      expect(requests).toBe(3);
    } finally {
      ui.unmount();
    }
  },
);
