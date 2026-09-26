import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCommands } from "../src/commands.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-cmds-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("slash commands", () => {
  it("reads frontmatter as YAML (colons in the description are fine) and adds enabled plugins' commands", () => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(home, ".claude", "commands", "ship.md"),
      "---\ndescription: Ship it: build, test, tag\nargument-hint: <version>\n---\nRelease $1",
    );
    const plugin = join(home, ".claude", "plugins", "cache", "mkt", "review", "1.0.0");
    mkdirSync(join(plugin, "commands"), { recursive: true });
    writeFileSync(
      join(plugin, "commands", "pr.md"),
      "---\ndescription: Review a PR\n---\nReview $ARGUMENTS",
    );
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "review@mkt": [{ scope: "user", installPath: plugin }] },
      }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "review@mkt": true } }),
    );
    const cmds = discoverCommands(ws, home);
    const ship = cmds.find((c) => c.name === "ship");
    expect(ship?.description).toBe("Ship it: build, test, tag");
    expect(ship?.argumentHint).toBe("<version>");
    expect(cmds.find((c) => c.name === "review:pr")?.description).toBe("Review a PR");
  });
});
