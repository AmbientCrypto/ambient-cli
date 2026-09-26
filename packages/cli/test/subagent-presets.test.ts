import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgent } from "@amb/context";
import type { CatalogModel } from "@amb/protocol";
import type { ChatParams, TurnCompletion } from "@amb/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSubagentTool, presetCatalog } from "../src/agent/subagent-tool.js";

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
  instructions: () => "",
  readMemory: () => undefined,
  writeMemory: () => {},
  date: () => "2026-09-25",
  platform: () => "test",
  skills: () => [],
};

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-presets-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("agent presets in the subagent tool", () => {
  it("lists presets by name with a one-line summary, bounded in size", () => {
    const presets = Array.from({ length: 200 }, (_, i) =>
      parseAgent(
        `---\nname: agent-${i}\ndescription: Does task ${i}. More detail here.\n---\nbody`,
      ),
    ).filter((p) => p !== null);
    const text = presetCatalog(presets);
    expect(text).toContain("  - agent-0: Does task 0.");
    expect(text).not.toContain("More detail");
    expect(text.length).toBeLessThan(4_200);
    expect(text).toMatch(/…and \d+ more/);
    const tool = makeSubagentTool({
      client: {
        fetchCatalog: async () => catalog,
        chat: async () => ({ content: "", toolCalls: [] }),
      },
      workspace,
      approve: async () => "deny",
      parentMode: "ask",
      presets: presets.slice(0, 2),
    });
    expect(tool.manifest.description).toContain("agent-1: Does task 1.");
  });

  it("runs a writing preset as a builder with its prompt as the child's instructions", async () => {
    mkdirSync(join(ws, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(ws, ".claude", "agents", "fixer.md"),
      '---\nname: fixer\ndescription: Fixes things\ntools: ["Read", "Edit"]\n---\nYOU ARE THE FIXER PRESET.',
    );
    const seen: ChatParams[] = [];
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (p: ChatParams): Promise<TurnCompletion> => {
        seen.push({ ...p, messages: [...p.messages] });
        return { content: "fixed it", toolCalls: [] };
      },
    };
    const tool = makeSubagentTool({
      client,
      workspace,
      approve: async () => "allow-once",
      parentMode: "bypass",
    });
    const out = (await tool.execute(
      { spawn: [{ label: "f", role: "scout", prompt: "fix the bug", preset: "fixer" }] },
      {
        cwd: ws,
        workspaceRoot: ws,
        signal: new AbortController().signal,
        secret: async () => "",
        emit: () => {},
        scope: { sessionId: "ses_p", turnId: "trn_p", attemptId: "att_p" },
        toolCallId: "tc_1",
      },
    )) as { results: Array<{ role: string }> };
    expect(out.results[0]?.role).toBe("builder");
    const system = String(seen[0]?.messages[0]?.content);
    expect(system).toContain("YOU ARE THE FIXER PRESET.");
    const task = String(seen[0]?.messages.at(-1)?.content);
    expect(task).toContain("fix the bug");
    expect(task).not.toContain("YOU ARE THE FIXER PRESET.");
    const tools = ((seen[0]?.tools ?? []) as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(tools.sort()).toEqual(["edit", "read"]);
  });
});
