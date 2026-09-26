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

describe("refresh", () => {
  it("reconnects from the current trust and closes the old connection", async () => {
    let trusted = true;
    let closed = 0;
    const connectImpl = async (_ws: string, opts: { approveServer?: () => Promise<boolean> }) => {
      const allowed = (await opts.approveServer?.()) === true;
      return {
        tools: [],
        currentTools: () => [],
        prompts: [],
        getPrompt: async () => "",
        notices: [],
        close: () => {
          closed++;
        },
        servers: allowed
          ? [{ name: "local", source: "project", transport: "stdio", state: "connected", tools: 2 }]
          : [],
      } as McpConnection;
    };
    const control = makeMcpControl({
      workspaceRoot: ws,
      connect: { approveServer: async () => trusted },
      store: makeTokenStore({ platform: "linux", configDir: ws }),
      connectImpl: connectImpl as never,
    });
    await control.start();
    expect(control.status()?.map((s) => s.name)).toEqual(["local"]);
    trusted = false;
    await control.refresh();
    expect(control.status()).toEqual([]);
    expect(closed).toBe(1);
    control.close();
  });
});

describe("refresh after trust is taken back", () => {
  it("drops the old servers at once, and they stay off if reconnecting fails", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const tool = { manifest: { name: "mcp__proj__t" } };
    const connectImpl = async () => {
      calls++;
      if (calls === 1)
        return {
          tools: [tool],
          currentTools: () => [tool],
          prompts: [],
          getPrompt: async () => "",
          notices: [],
          close: () => {},
          servers: [],
        } as unknown as McpConnection;
      await new Promise<void>((r) => {
        release = r;
      });
      throw new Error("offline");
    };
    const control = makeMcpControl({
      workspaceRoot: ws,
      connect: { approveServer: async () => false },
      store: makeTokenStore({ platform: "linux", configDir: ws }),
      connectImpl: connectImpl as never,
    });
    await control.start();
    expect(control.tools()).toHaveLength(1);
    const pending = control.refresh();
    expect(control.tools()).toEqual([]); // gone before the reconnect finishes
    release?.();
    await expect(pending).rejects.toThrow("offline");
    expect(control.tools()).toEqual([]);
    control.close();
  });
});

describe("a folder whose trust lapses mid-session", () => {
  it("loses its servers the next time tools are handed out", async () => {
    let trusted = true;
    let connects = 0;
    const tool = { manifest: { name: "mcp__proj__t" } };
    const connectImpl = async (_ws: string, o: { approveServer?: () => Promise<boolean> }) => {
      connects++;
      const allowed = (await o.approveServer?.()) === true;
      return {
        tools: allowed ? [tool] : [],
        currentTools: () => (allowed ? [tool] : []),
        prompts: [],
        getPrompt: async () => "",
        notices: [],
        close: () => {},
        servers: allowed
          ? [{ name: "proj", source: "project", transport: "stdio", state: "connected", tools: 1 }]
          : [],
      } as unknown as McpConnection;
    };
    const control = makeMcpControl({
      workspaceRoot: ws,
      connect: { approveServer: async () => trusted },
      store: makeTokenStore({ platform: "linux", configDir: ws }),
      connectImpl: connectImpl as never,
      projectTrusted: () => trusted,
    });
    await control.start();
    expect(control.tools()).toHaveLength(1);
    trusted = false; // e.g. its settings file changed
    expect(control.tools()).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(connects).toBe(2);
    expect(control.tools()).toEqual([]);
    control.close();
  });
});
