import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpConnection } from "../src/agent/mcp-connect.js";
import { makeMcpControl, mcpReport } from "../src/agent/mcp-control.js";
import { makeTokenStore } from "../src/mcp-auth/token-store.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-mcpctl-"));
  writeFileSync(
    join(ws, ".mcp.json"),
    JSON.stringify({
      remote: { type: "http", url: "https://mcp.example/mcp" },
      local: { command: "x" },
    }),
  );
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("MCP status and sign-in in a session", () => {
  it("reports each server, then signs in and reconnects so the tools arrive", async () => {
    let signedIn = false;
    let closed = 0;
    const connectImpl = async (): Promise<McpConnection> => ({
      tools: [],
      currentTools: () => [],
      prompts: [],
      getPrompt: async () => "",
      notices: [],
      close: () => {
        closed++;
      },
      servers: [
        signedIn
          ? { name: "remote", source: "project", transport: "http", state: "connected", tools: 3 }
          : {
              name: "remote",
              source: "project",
              transport: "http",
              state: "needs-sign-in",
              tools: 0,
            },
        {
          name: "local",
          source: "project",
          transport: "stdio",
          state: "failed",
          tools: 0,
          detail: "exited",
        },
      ],
    });
    const untrusted = makeMcpControl({
      workspaceRoot: ws,
      connect: { approveServer: async () => false },
      store: makeTokenStore({ platform: "linux", configDir: ws }),
      connectImpl,
      signInImpl: async () => {
        throw new Error("must not sign in to an untrusted project's server");
      },
    });
    expect(await untrusted.login("remote", () => {})).toContain("trust the project first");

    const ctl = makeMcpControl({
      workspaceRoot: ws,
      connect: { approveServer: async () => true },
      store: makeTokenStore({ platform: "linux", configDir: ws }),
      connectImpl,
      signInImpl: async () => {
        signedIn = true;
        return {};
      },
    });
    expect(mcpReport(ctl.status())).toBe("MCP servers are still connecting…");
    await ctl.start();
    const report = mcpReport(ctl.status());
    expect(report).toContain("MCP servers (0 of 2 connected):");
    expect(report).toContain("remote  needs sign-in");
    expect(report).toContain("local   failed · exited");
    expect(report).toContain("Sign in with /mcp login remote");

    expect(await ctl.login("local", () => {})).toBe(
      "local runs on this machine and has no sign-in.",
    );
    expect(await ctl.login("nope", () => {})).toContain('No MCP server named "nope"');
    expect(await ctl.login("remote", () => {})).toBe("Signed in to remote · 3 tools ready.");
    expect(closed).toBe(1); // the old connection was closed when the new one took over
    ctl.close();
    expect(closed).toBe(2);
  });

  it("says when no servers are configured", () => {
    expect(mcpReport([])).toBe("No MCP servers configured.");
  });
});

describe("MCP prompts as slash commands", () => {
  it("maps typed words to the prompt's arguments, the last one taking the rest", async () => {
    const asked: Array<Record<string, string>> = [];
    const ctl = makeMcpControl({
      workspaceRoot: ws,
      connect: {},
      store: makeTokenStore({ platform: "linux", configDir: ws }),
      connectImpl: async () => ({
        tools: [],
        currentTools: () => [],
        notices: [],
        close: () => {},
        servers: [],
        prompts: [
          {
            server: "gh",
            prompt: {
              name: "review",
              description: "Review a pull request",
              arguments: [{ name: "pr", required: true }, { name: "focus" }],
            },
          },
        ],
        getPrompt: async (_s, _n, args) => {
          asked.push(args);
          return "PROMPT TEXT";
        },
      }),
    });
    await ctl.start();
    expect(ctl.promptCommands()).toEqual([
      { name: "/mcp__gh__review", desc: "Review a pull request (gh)", args: "<pr> [focus]" },
    ]);
    expect(await ctl.expandPrompt("/mcp__gh__review", '42 "error handling" and tests')).toBe(
      "PROMPT TEXT",
    );
    expect(asked[0]).toEqual({ pr: "42", focus: "error handling and tests" });
    await expect(ctl.expandPrompt("/mcp__gh__review", "")).rejects.toThrow("needs pr");
    await expect(ctl.expandPrompt("/mcp__gh__other", "")).rejects.toThrow("isn't available");
  });
});
