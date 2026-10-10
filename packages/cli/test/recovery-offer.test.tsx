import type { NewEvent } from "@amb/protocol";
import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import { App } from "../src/tui/App.js";

it("offers recovery without executing, then restores on explicit Ctrl+Y confirmation", async () => {
  let requests = 0;
  let messages = "";
  const client = {
    fetchCatalog: async () => [
      {
        id: "m",
        name: "m",
        contextLength: 128_000,
        maxOutputLength: 8192,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportedFeatures: ["tools"],
        supportedSamplingParameters: [],
        isReady: true,
      },
    ],
    chat: async (params) => {
      requests++;
      messages = JSON.stringify(params.messages);
      return { content: "RECOVERED", toolCalls: [] };
    },
  } as ChatClient;
  const recovery = {
    fromSessionId: "ses_before",
    context: "SAVED CONTEXT",
    recoveryNotes: [],
    droppedTail: 0,
    interrupted: true,
    task: "repair CI",
    plan: [{ text: "verify", status: "active" as const }],
    pendingMessages: [{ messageId: "queued", text: "check failure", attachments: [] }],
  };
  const ui = render(
    <App
      client={client}
      makeWriter={() =>
        ({ append(_event: NewEvent) {}, path: "/dev/null" }) as unknown as SessionWriter
      }
      recovery={recovery}
      agentMode="build"
      permission="bypass"
      effort="auto"
      requestedModel="m"
      maxTurns={3}
      cwd={process.cwd()}
      workspaceRoot={process.cwd()}
    />,
  );
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(requests).toBe(0);
    expect(ui.lastFrame()).toContain("Restore the previous interrupted session?");
    ui.stdin.write("\x19");
    const deadline = Date.now() + 3000;
    while (!requests && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(messages).toContain("SAVED CONTEXT");
    expect(messages).toContain("check failure");
    expect(messages).toContain("verify");
  } finally {
    ui.unmount();
  }
});

it.each(["new task", "pasted task\nwith details", "\r", "\x1b"])(
  "input %j starts fresh without submitting the interrupted task",
  async (text) => {
    let requests = 0;
    let dismissals = 0;
    const ui = render(
      <App
        client={
          {
            fetchCatalog: async () => [],
            chat: async () => {
              requests++;
              return { content: "", toolCalls: [] };
            },
          } as unknown as ChatClient
        }
        makeWriter={() => ({ append() {} }) as unknown as SessionWriter}
        maxTurns={3}
        onDismissRecovery={() => {
          dismissals++;
        }}
        recovery={{
          fromSessionId: "ses_before",
          context: "SAVED CONTEXT",
          recoveryNotes: [],
          droppedTail: 0,
          interrupted: true,
          task: "previous task",
          plan: [],
          pendingMessages: [],
        }}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="m"
        cwd={process.cwd()}
        workspaceRoot={process.cwd()}
      />,
    );
    try {
      await new Promise((r) => setTimeout(r, 100));
      ui.stdin.write(text);
      await new Promise((r) => setTimeout(r, 100));
      expect(ui.lastFrame()).not.toContain("Restore the previous interrupted session?");
      if (text !== "\r" && text !== "\x1b")
        for (const line of text.split("\n")) expect(ui.lastFrame()).toContain(line);
      expect(requests).toBe(0);
      expect(dismissals).toBe(1);
    } finally {
      ui.unmount();
    }
  },
);
