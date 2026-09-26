import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, Msg, WorkspaceContextPort } from "@amb/runtime";
import { describe, expect, it } from "vitest";
import { compactNow } from "../src/agent/compact-now.js";

const catalog: CatalogModel[] = [
  {
    id: "vendor/m",
    name: "m",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 131_072,
    maxOutputLength: 8_192,
    isReady: true,
  },
];
const workspace = {
  readMemory: () => undefined,
  writeMemory: () => {},
} as unknown as WorkspaceContextPort;
const long = (s: string) => `${s} ${"words ".repeat(700)}`;

describe("/compact on a carried conversation", () => {
  it("summarizes earlier tasks in order and keeps only the latest exchange after the summary", async () => {
    const calls: ChatParams[] = [];
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (p: ChatParams) => {
        calls.push(p);
        return { content: "## Goal\nsummary", toolCalls: [] };
      },
    } as unknown as ChatClient;
    // Each run's task comes back pinned — that's how the app carries the conversation.
    const conversation: Msg[] = [
      { role: "user", content: long("task one"), pinned: true },
      { role: "assistant", content: long("answer one") },
      { role: "user", content: long("task two"), pinned: true },
      { role: "assistant", content: long("answer two") },
      { role: "user", content: "task three", pinned: true },
      { role: "assistant", content: "answer three" },
    ];
    const res = await compactNow({
      client,
      conversation,
      model: "vendor/m",
      workspace,
      workspaceRoot: "/w",
      sessionId: "ses_c",
      signal: new AbortController().signal,
      emit: () => {},
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const order = res.messages.map((m) => `${m.role}:${String(m.content).slice(0, 10)}`);
    expect(order.slice(-2)).toEqual(["user:task three", "assistant:answer thr"]);
    expect(order.filter((o) => o.startsWith("user:"))).toEqual(["user:task three"]);
    const summarized = String(calls[0]?.messages.at(-1)?.content);
    expect(summarized.indexOf("task one")).toBeGreaterThanOrEqual(0);
    expect(summarized.indexOf("task one")).toBeLessThan(summarized.indexOf("task two"));
  });
});
