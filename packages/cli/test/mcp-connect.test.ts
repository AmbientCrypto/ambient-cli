import type { McpServerSpec } from "@amb/context";
import type { ToolDefinition } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { connectMcp } from "../src/agent/mcp-connect.js";

import type { ConnectOptions } from "../src/agent/mcp-connect.js";

const fakeTool = (name: string): ToolDefinition =>
  ({ manifest: { name } }) as unknown as ToolDefinition;
const stubStart = ((specs: { name: string }[]) =>
  Promise.resolve({
    tools: specs.map((s) => fakeTool(`mcp__${s.name}__t`)),
    close: () => {},
  })) as unknown as NonNullable<ConnectOptions["start"]>;

describe("connectMcp", () => {
  it("returns nothing when no servers are configured", async () => {
    const c = await connectMcp("/ws", { load: () => [] });
    expect(c.tools).toEqual([]);
  });

  it("connects a remote (http) user-scoped server (passes a {url} config)", async () => {
    const seen: unknown[] = [];
    const start = ((specs: { name: string; config: unknown }[]) => {
      for (const s of specs) seen.push(s.config);
      return Promise.resolve({
        tools: specs.map((s) => fakeTool(`mcp__${s.name}__t`)),
        close: () => {},
      });
    }) as unknown as NonNullable<ConnectOptions["start"]>;
    const specs: McpServerSpec[] = [
      { name: "remote", transport: "http", url: "https://x/mcp", source: "user" },
    ];
    const c = await connectMcp("/ws", { load: () => specs, start });
    expect(c.tools.map((t) => t.manifest.name)).toEqual(["mcp__remote__t"]);
    expect(seen).toEqual([{ url: "https://x/mcp" }]); // an http {url} config, not stdio
  });

  it("skips a truly-unknown transport with a notice", async () => {
    const specs = [
      { name: "weird", transport: "grpc", url: "x", source: "user" },
    ] as unknown as McpServerSpec[];
    const c = await connectMcp("/ws", { load: () => specs, start: stubStart });
    expect(c.tools).toEqual([]);
    expect(c.notices.some((n) => n.includes("not supported"))).toBe(true);
  });

  it("gates a PROJECT-scoped server behind approval; user-scoped auto-connects", async () => {
    const specs: McpServerSpec[] = [
      { name: "proj", transport: "stdio", command: "x", source: "project" },
      { name: "user", transport: "stdio", command: "y", source: "user" },
    ];
    const denied = await connectMcp("/ws", {
      load: () => specs,
      start: stubStart,
      approveServer: async () => false,
    });
    expect(denied.tools.map((t) => t.manifest.name)).toEqual(["mcp__user__t"]); // only the user server
    expect(
      denied.notices.some(
        (n) => n.includes("proj") && n.includes("starts once you trust the project"),
      ),
    ).toBe(true);

    const approved = await connectMcp("/ws", {
      load: () => specs,
      start: stubStart,
      approveServer: async () => true,
    });
    expect(approved.tools.map((t) => t.manifest.name).sort()).toEqual([
      "mcp__proj__t",
      "mcp__user__t",
    ]);
  });

  it("fails CLOSED: with NO approver, a project-scoped server is not admitted", async () => {
    const specs: McpServerSpec[] = [
      { name: "proj", transport: "stdio", command: "x", source: "project" },
      { name: "user", transport: "stdio", command: "y", source: "user" },
    ];
    // No approveServer supplied at all — the project server must be skipped, not silently spawned.
    const c = await connectMcp("/ws", { load: () => specs, start: stubStart });
    expect(c.tools.map((t) => t.manifest.name)).toEqual(["mcp__user__t"]);
    expect(
      c.notices.some((n) => n.includes("proj") && n.includes("starts once you trust the project")),
    ).toBe(true);
  });
});
