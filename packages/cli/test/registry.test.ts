import type { ToolDefinition } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/agent/registry.js";
import { childRegistry, makeSubagentTool } from "../src/agent/subagent-tool.js";

const fakeTool = (name: string): ToolDefinition =>
  ({
    manifest: {
      name,
      version: "1",
      description: name,
      effects: ["read"],
      idempotency: "idempotent",
      parallelSafe: true,
      resumability: "inspect",
      timeoutPolicy: { idleMs: 1000, maximumMs: 1000 },
    },
    inputSchema: { safeParse: () => ({ success: true, data: {} }) },
    outputSchema: { safeParse: () => ({ success: true, data: {} }) },
    execute: async () => ({}),
  }) as unknown as ToolDefinition;

describe("buildRegistry", () => {
  it("registers the 21 builtins plus injected mcp + subagent tools", () => {
    const reg = buildRegistry({
      mcpTools: [fakeTool("mcp__docs__search")],
      subagent: fakeTool("subagent"),
    });
    const names = reg.list().map((t) => t.manifest.name);
    expect(names).toContain("read");
    expect(names).toContain("mcp__docs__search");
    expect(names).toContain("subagent");
    expect(names).toContain("search_skills");
    expect(names).toContain("ask_user");
    expect(names).toContain("propose_goal_update");
    expect(reg.list().length).toBe(21 + 2);
  });

  it("throws on a duplicate tool name (catches a namespace collision)", () => {
    expect(() => buildRegistry({ mcpTools: [fakeTool("read")] })).toThrow();
  });
});

describe("makeSubagentTool", () => {
  const tool = makeSubagentTool({
    client: { fetchCatalog: async () => [], chat: async () => ({ content: "", toolCalls: [] }) },
    workspace: {
      instructions: () => "",
      readMemory: () => undefined,
      writeMemory: () => {},
      date: () => "2026-09-02",
      platform: () => "test",
      skills: () => [],
    },
    approve: async () => "deny",
    parentMode: "ask",
  });

  it("is a read-effect delegation tool named 'subagent' with a bounded spawn list", () => {
    expect(tool.manifest.name).toBe("subagent");
    expect(tool.manifest.effects).toEqual(["read"]); // frictionless spawn; children obey the ladder
    // rejects an empty spawn and an over-cap spawn
    expect(tool.inputSchema.safeParse({ spawn: [] }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({ spawn: Array.from({ length: 17 }, () => ({ prompt: "x" })) })
        .success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ spawn: [{ label: "s", prompt: "look", role: "scout" }] })
        .success,
    ).toBe(true);
  });

  it("refuses to run without a scoped ToolContext (parent correlation)", async () => {
    await expect(
      tool.execute({ spawn: [{ label: "s", role: "scout", prompt: "x" }] }, {
        cwd: "/tmp",
        workspaceRoot: "/tmp",
        signal: new AbortController().signal,
        secret: async () => "",
        emit: () => {},
      } as never),
    ).rejects.toThrow(/scoped ToolContext/);
  });
});

describe("childRegistry — preset tool confinement", () => {
  it("an unrestricted builder gets the full builtin set incl. write/bash", () => {
    const names = childRegistry("builder")
      .list()
      .map((t) => t.manifest.name);
    expect(names).toContain("write");
    expect(names).toContain("bash");
    expect(names).not.toContain("subagent"); // never a grandchild
  });
  it("ENFORCES a preset allow-list on a builder — a `tools: read, grep` builder can't write/exec", () => {
    const names = childRegistry("builder", ["read", "grep"])
      .list()
      .map((t) => t.manifest.name)
      .sort();
    expect(names).toEqual(["grep", "read"]); // exactly the allow-list — no write/bash/edit
  });
  it("intersects the allow-list with the scout read-only constraint (a write in the list is dropped)", () => {
    // A scout is read-only; even if the preset lists `write`, the role constraint wins → write excluded.
    const names = childRegistry("scout", ["read", "write"])
      .list()
      .map((t) => t.manifest.name);
    expect(names).toContain("read");
    expect(names).not.toContain("write");
  });
  it("children get MCP tools: builders all, scouts the read-only ones, presets by tool or server", () => {
    const mcp = (name: string, effects: ("read" | "process")[]) =>
      ({
        ...childRegistry("builder").list()[0],
        manifest: { ...childRegistry("builder").list()[0]?.manifest, name, effects },
      }) as never;
    const tools = [mcp("mcp__docs__search", ["read"]), mcp("mcp__gh__merge", ["process"])];
    const names = (r: ReturnType<typeof childRegistry>) => r.list().map((t) => t.manifest.name);
    expect(names(childRegistry("builder", undefined, tools))).toEqual(
      expect.arrayContaining(["mcp__docs__search", "mcp__gh__merge"]),
    );
    const scout = names(childRegistry("scout", undefined, tools));
    expect(scout).toContain("mcp__docs__search");
    expect(scout).not.toContain("mcp__gh__merge");
    expect(names(childRegistry("builder", ["read", "mcp__gh"], tools)).sort()).toEqual([
      "mcp__gh__merge",
      "read",
    ]);
  });
});
