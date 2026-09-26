import type { ToolDefinition } from "@amb/protocol";
import { ToolRegistry } from "@amb/tools-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../src/agent.js";
import { BackgroundTasks } from "../src/background-tasks.js";
import type { ChatClient, ChatParams, RunOptions } from "../src/ports.js";
import { TEXT_200K, catalogOf } from "./fixtures/catalog.js";

describe("BackgroundTasks", () => {
  it("hands each finished report over once, and settles when all are done", async () => {
    const tasks = new BackgroundTasks();
    let finish: (v: string) => void = () => {};
    tasks.start(
      "scan",
      () =>
        new Promise<string>((r) => {
          finish = r;
        }),
    );
    expect(tasks.running()).toBe(1);
    expect(tasks.takeFinished()).toEqual([]);
    finish("found 3 callers");
    await tasks.settled(new AbortController().signal);
    expect(tasks.takeFinished()).toEqual([
      { id: "task1", label: "scan", report: "found 3 callers" },
    ]);
    expect(tasks.takeFinished()).toEqual([]);
  });
  it("a failure is a report too; stopAll aborts what's running", async () => {
    const tasks = new BackgroundTasks();
    tasks.start("bad", async () => {
      throw new Error("boom");
    });
    let aborted = false;
    tasks.start(
      "long",
      (signal) =>
        new Promise<string>((r) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            r("stopped");
          }),
        ),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(tasks.takeFinished()[0]?.report).toBe("failed: boom");
    tasks.stopAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
  });
});

describe("the agent and its background tasks", () => {
  it("waits for a background report before its final answer, and reads it", async () => {
    const schema = z.object({}).passthrough() as unknown as ToolDefinition["inputSchema"];
    const delegate: ToolDefinition = {
      manifest: {
        name: "delegate",
        version: "1",
        description: "start background work",
        effects: ["read"],
        idempotency: "idempotent",
        parallelSafe: false,
        resumability: "inspect",
        timeoutPolicy: { idleMs: 2_000, maximumMs: 2_000 },
      },
      inputSchema: schema,
      outputSchema: schema,
      execute: async (_i, ctx) => {
        const { id } = ctx.backgroundTasks?.start(
          "survey",
          () => new Promise((r) => setTimeout(() => r("SURVEY: 12 endpoints"), 30)),
        ) ?? { id: "none" };
        return { started: id };
      },
    };
    const calls: ChatParams[] = [];
    const replies = [
      { content: "", toolCalls: [{ id: "tc_d", name: "delegate", args: {}, rawArgs: "{}" }] },
      { content: "Started it.", toolCalls: [] }, // tries to finish while the task runs
      { content: "There are 12 endpoints.", toolCalls: [] },
    ];
    const client: ChatClient = {
      fetchCatalog: async () => catalogOf(TEXT_200K),
      chat: async (p) => {
        calls.push(p);
        const next = replies.shift();
        if (!next) throw new Error("script exhausted");
        return next;
      },
    };
    const opts: RunOptions = {
      sessionId: "ses_bg0001",
      mode: "bypass",
      requestedModel: TEXT_200K.id,
      maxTurns: 8,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      signal: new AbortController().signal,
      emit: () => {},
      approve: async () => "allow-once",
      workspace: {
        instructions: () => "",
        readMemory: () => undefined,
        writeMemory: () => {},
        date: () => "2026-09-25",
        platform: () => "test",
        skills: () => [],
      },
    };
    const res = await new Agent(client, new ToolRegistry().register(delegate)).run(
      "survey the api",
      opts,
    );
    expect(res.finalText).toContain("12 endpoints");
    const last =
      calls
        .at(-1)
        ?.messages.map((m) => String(m.content))
        .join("\n") ?? "";
    expect(last).toContain("SURVEY: 12 endpoints");
  });
});
