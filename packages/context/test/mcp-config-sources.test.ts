import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/mcp-config.js";

let dir: string;
let home: string;
let ws: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-mcpcfg-"));
  home = join(dir, "home");
  ws = join(dir, "ws");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(ws, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const byName = (specs: ReturnType<typeof loadMcpConfig>) =>
  Object.fromEntries(specs.map((s) => [s.name, s]));

describe("remote server auth", () => {
  it("fills headers from the environment and names what's missing", () => {
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          gh: {
            type: "http",
            url: "https://api.x/mcp",
            headers: { Authorization: "Bearer ${GH_TOKEN}" },
          },
          nokey: { type: "http", url: "https://y/mcp", headers: { "X-Key": "${NOT_SET_VAR}" } },
          dflt: { type: "http", url: "${HOST:-https://z}/mcp" },
        },
      }),
    );
    const s = byName(loadMcpConfig(ws, { GH_TOKEN: "abc" }, home));
    expect(s.gh?.headers).toEqual({ Authorization: "Bearer abc" });
    expect(s.gh?.missingEnv).toBeUndefined();
    expect(s.nokey?.missingEnv).toEqual(["NOT_SET_VAR"]);
    expect(s.dflt?.url).toBe("https://z/mcp");
  });

  it("reads Codex's bearer_token_env_var, http_headers and env_http_headers", () => {
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.linear]",
        'url = "https://mcp.linear.app/mcp"',
        'bearer_token_env_var = "LINEAR_TOKEN"',
        'http_headers = { "X-Team" = "core" }',
        'env_http_headers = { "X-Org" = "ORG_ID" }',
      ].join("\n"),
    );
    const s = byName(loadMcpConfig(ws, { LINEAR_TOKEN: "t0k", ORG_ID: "o1" }, home));
    expect(s.linear?.headers).toEqual({
      Authorization: "Bearer t0k",
      "X-Team": "core",
      "X-Org": "o1",
    });
    expect(byName(loadMcpConfig(ws, {}, home)).linear?.missingEnv).toEqual([
      "ORG_ID",
      "LINEAR_TOKEN",
    ]);
  });

  it("a legacy sse server keeps its transport", () => {
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({ old: { type: "sse", url: "https://o/sse" } }),
    );
    expect(loadMcpConfig(ws, {}, home)[0]?.transport).toBe("sse");
  });
});

describe("where servers come from", () => {
  it("this project's `claude mcp add` entries in ~/.claude.json win, and count as the user's", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { shared: { command: "global-shared" } },
        projects: {
          [ws]: {
            mcpServers: { shared: { command: "local-shared" }, only: { command: "local-only" } },
          },
          "/other/project": { mcpServers: { other: { command: "nope" } } },
        },
      }),
    );
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ shared: { command: "project-shared" } }));
    const s = byName(loadMcpConfig(ws, {}, home));
    expect(s.shared?.command).toBe("local-shared");
    expect(s.shared?.source).toBe("user");
    expect(s.only?.command).toBe("local-only");
    expect(s.other).toBeUndefined();
  });

  it("enabled plugins' servers load only when asked, namespaced, with their folder filled in", () => {
    const root = join(home, ".claude", "plugins", "cache", "mkt", "tools", "1.0.0");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "tools@mkt": [{ scope: "user", installPath: root }] },
      }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "tools@mkt": true } }),
    );
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        search: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/search",
          args: ["--root", "${CLAUDE_PLUGIN_ROOT}"],
        },
      }),
    );
    expect(loadMcpConfig(ws, {}, home)).toEqual([]);
    const [spec] = loadMcpConfig(ws, {}, home, { plugins: true });
    expect(spec?.name).toBe("plugin_tools_search");
    expect(spec?.source).toBe("plugin");
    expect(spec?.command).toBe(`${root}/bin/search`);
    expect(spec?.args).toEqual(["--root", root]);
  });
});
