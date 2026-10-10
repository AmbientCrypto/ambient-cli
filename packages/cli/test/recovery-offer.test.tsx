import type { NewEvent } from "@amb/protocol";
import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import { App } from "../src/tui/App.js";

it("offers recovery without executing, then restores context and queued steering on Enter", async () => {
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
    expect(ui.lastFrame()).toContain("Resume interrupted session");
    ui.stdin.write("\r");
    const deadline = Date.now() + 3000;
    while (!requests && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(messages).toContain("SAVED CONTEXT");
    expect(messages).toContain("check failure");
    expect(messages).toContain("verify");
  } finally {
    ui.unmount();
  }
});
