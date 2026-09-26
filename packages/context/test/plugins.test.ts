import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedPlugins } from "../src/plugins.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-plugins-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(): { home: string; ws: string } {
  const home = join(dir, "home");
  const ws = join(dir, "ws");
  const cache = join(home, ".claude", "plugins", "cache", "mkt");
  for (const p of ["alpha/1.0.0", "alpha/2.0.0", "beta/1.0.0", "gamma/1.0.0", "local/1.0.0"]) {
    mkdirSync(join(cache, p), { recursive: true });
  }
  mkdirSync(join(ws, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "alpha@mkt": [
          { scope: "user", installPath: join(cache, "alpha/1.0.0"), lastUpdated: "2026-01-01" },
          { scope: "user", installPath: join(cache, "alpha/2.0.0"), lastUpdated: "2026-06-01" },
        ],
        "beta@mkt": [{ scope: "user", installPath: join(cache, "beta/1.0.0") }],
        "gamma@mkt": [{ scope: "user", installPath: join(cache, "gamma/1.0.0") }],
        "local@mkt": [
          { scope: "local", projectPath: "/elsewhere", installPath: join(cache, "local/1.0.0") },
        ],
      },
    }),
  );
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { "alpha@mkt": true, "beta@mkt": true, "local@mkt": true } }),
  );
  // The project turns beta off.
  writeFileSync(
    join(ws, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { "beta@mkt": false } }),
  );
  return { home, ws };
}

describe("installed plugins", () => {
  it("returns enabled plugins at their newest applicable version", () => {
    const { home, ws } = setup();
    // The project's own choice (beta off) counts only once the project is trusted.
    expect(installedPlugins(ws, home).map((p) => p.id)).toEqual(["alpha@mkt", "beta@mkt"]);
    const plugins = installedPlugins(ws, home, { projectSettings: true });
    expect(plugins.map((p) => p.id)).toEqual(["alpha@mkt"]);
    expect(plugins[0]?.root).toMatch(/alpha[/\\]2\.0\.0$/);
    expect(plugins[0]?.name).toBe("alpha");
  });
  it("includes a project-scoped install only in its own project", () => {
    const { home } = setup();
    expect(installedPlugins("/elsewhere", home).map((p) => p.id)).toContain("local@mkt");
  });
  it("is empty without an install record", () => {
    expect(installedPlugins(join(dir, "ws"), join(dir, "nohome"))).toEqual([]);
  });
});

describe("plugin agents", () => {
  it("come from enabled plugins, named plugin:agent", async () => {
    const { home, ws } = setup();
    const root = join(home, ".claude", "plugins", "cache", "mkt", "alpha", "2.0.0", "agents");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\n---\nReview carefully.",
    );
    const { discoverAgents } = await import("../src/agents.js");
    const agent = discoverAgents(ws, home).find((a) => a.name === "alpha:reviewer");
    expect(agent?.description).toBe("Reviews code");
    expect(agent?.tools).toEqual(["read", "grep"]);
  });
});
