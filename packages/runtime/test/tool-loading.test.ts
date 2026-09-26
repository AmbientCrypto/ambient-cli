import type { ToolDefinition } from "@amb/protocol";
import { ToolRegistry, createBuiltinRegistry } from "@amb/tools-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../src/agent.js";
import { LOAD_TOOLS, ToolLoader } from "../src/tool-loading.js";
import { FixtureClient, TEXT_1M, VISION_32K, catalogOf, runOpts } from "./fixtures/catalog.js";

const ran: string[] = [];
function mcpTool(server: string, name: string, description: string): ToolDefinition {
  return {
    manifest: {
      name: `mcp__${server}__${name}`,
      version: "1",
      description: `${description} ${"detail ".repeat(40)}`,
      effects: ["read"],
      idempotency: "pure",
      parallelSafe: true,
      resumability: "replay",
      timeoutPolicy: { idleMs: 1_000, maximumMs: 2_000 },
    },
    inputSchema: z.object({ q: z.string().optional() }),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute() {
      ran.push(name);
      return { ok: true };
    },
  };
}
const manyTools = () => [
  ...Array.from({ length: 40 }, (_, i) => mcpTool("browser", `action_${i}`, `browser action ${i}`)),
  mcpTool("browser", "take_screenshot", "Take a screenshot of the page"),
  ...Array.from({ length: 20 }, (_, i) =>
    mcpTool("tracker", `issue_${i}`, `tracker issue op ${i}`),
  ),
];

describe("ToolLoader", () => {
  it("offers everything when it fits, and on demand when it doesn't", () => {
    const tools = manyTools();
    expect(new ToolLoader(tools, () => 1_000_000).onDemand).toBe(false);
    const small = new ToolLoader(tools, () => 1_500);
    expect(small.onDemand).toBe(true);
    expect(small.offered()).toEqual([]);
    expect(small.index()).toBe("browser (41), tracker (20)");
    const r = small.load("take a screenshot");
    expect(r.loaded[0]?.manifest.name).toBe("mcp__browser__take_screenshot");
    expect(small.offered().map((t) => t.manifest.name)).toContain("mcp__browser__take_screenshot");
  });
});

describe("on-demand tools in a run", () => {
  it("a 32K model sees the index, loads the tool it needs, then calls it", async () => {
    ran.length = 0;
    const registry = createBuiltinRegistry();
    for (const t of manyTools()) registry.register(t);
    const client = new FixtureClient(catalogOf(VISION_32K), [
      {
        content: "",
        toolCalls: [{ id: "tc_1", name: LOAD_TOOLS, args: { query: "screenshot" }, rawArgs: "{}" }],
      },
      {
        content: "",
        toolCalls: [{ id: "tc_2", name: "mcp__browser__take_screenshot", args: {}, rawArgs: "{}" }],
      },
      { content: "done", toolCalls: [] },
    ]);
    await new Agent(client, registry).run(
      "screenshot the page",
      runOpts({ requestedModel: VISION_32K.id, mode: "bypass" }),
    );
    const names = (i: number) =>
      ((client.calls[i]?.tools ?? []) as Array<{ function: { name: string } }>).map(
        (t) => t.function.name,
      );
    expect(names(0)).toContain(LOAD_TOOLS);
    expect(names(0).some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(names(1)).toContain("mcp__browser__take_screenshot");
    expect(ran).toEqual(["take_screenshot"]);
  });
  it("a large model with room gets every tool up front and no loader", async () => {
    const registry = new ToolRegistry();
    for (const t of manyTools().slice(0, 5)) registry.register(t);
    const client = new FixtureClient(catalogOf(TEXT_1M), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client, registry).run("hi", runOpts({ requestedModel: TEXT_1M.id }));
    const names = ((client.calls[0]?.tools ?? []) as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(names).not.toContain(LOAD_TOOLS);
    expect(names.filter((n) => n.startsWith("mcp__"))).toHaveLength(5);
  });
});
