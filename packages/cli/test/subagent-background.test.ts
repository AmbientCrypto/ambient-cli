import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewEvent, ToolContext } from "@amb/protocol";
import { BackgroundTasks } from "@amb/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSubagentTool } from "../src/agent/subagent-tool.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-bgwave-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const catalog = [
  {
    id: "m/x",
    name: "m/x",
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextLength: 131_072,
    maxOutputLength: 8_192,
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    isReady: true,
  },
];

describe("a background subagent wave", () => {
  it("returns at once, reports through the task, and keeps its child rows off the live panel", async () => {
    const tool = makeSubagentTool({
      client: {
        fetchCatalog: async () => catalog as never,
        chat: async () => ({ content: "FOUND: 3 files", toolCalls: [] }),
      },
      workspace: {
        instructions: () => "",
        readMemory: () => undefined,
        writeMemory: () => {},
        date: () => "2026-09-25",
        platform: () => "test",
        skills: () => [],
      },
      approve: async () => "deny",
      parentMode: "bypass",
    });
    const events: NewEvent[] = [];
    const tasks = new BackgroundTasks();
    const ctx = {
      cwd: ws,
      workspaceRoot: ws,
      signal: new AbortController().signal,
      secret: async () => "",
      emit: (e: NewEvent) => events.push(e),
      scope: { sessionId: "ses_bgw0001", turnId: "trn_bgw0001", attemptId: "att_bgw0001" },
      toolCallId: "tc_bgw0001",
      backgroundTasks: tasks,
    } as unknown as ToolContext;
    const out = (await tool.execute(
      { spawn: [{ label: "count", role: "scout", prompt: "count files" }], background: true },
      ctx,
    )) as { summary: string };
    expect(out.summary).toMatch(/in the background as task1/);
    await tasks.settled(new AbortController().signal);
    expect(tasks.takeFinished()[0]?.report).toContain("FOUND: 3 files");
    expect(events.some((e) => e.kind.startsWith("subagent."))).toBe(false);
    const notices = events
      .filter((e) => e.kind === "notice")
      .map((e) => (e as { text: string }).text);
    expect(notices).toEqual([
      "Started 1 subagent in the background: count",
      "Background 1 subagent reported (count)",
    ]);
  });
});
