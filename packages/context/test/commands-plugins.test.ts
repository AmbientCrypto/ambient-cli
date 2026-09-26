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

describe("a trusted project's plugin choices", () => {
  it("apply to a plugin's commands, skills and agents the way they do to its hooks and MCP", async () => {
    const { discoverAgents } = await import("../src/agents.js");
    const { discoverSkills, loadSkill, searchSkills } = await import("../src/skills.js");
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    const plugin = join(home, ".claude", "plugins", "cache", "mkt", "review", "1.0.0");
    for (const sub of ["commands", "agents", join("skills", "triage")])
      mkdirSync(join(plugin, sub), { recursive: true });
    writeFileSync(join(plugin, "commands", "pr.md"), "---\ndescription: Review a PR\n---\nReview");
    writeFileSync(
      join(plugin, "agents", "critic.md"),
      "---\nname: critic\ndescription: Critic\n---\nBe critical",
    );
    writeFileSync(
      join(plugin, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Triage bugs\n---\nSteps",
    );
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "review@mkt": [{ scope: "user", installPath: plugin }] } }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "review@mkt": true } }),
    );
    // The project turns the plugin off.
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(
      join(ws, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "review@mkt": false } }),
    );
    const found = (projectSettings: boolean) => ({
      command: discoverCommands(ws, home, { projectSettings }).some((c) => c.name === "review:pr"),
      agent: discoverAgents(ws, home, { projectSettings }).some((a) => a.name === "review:critic"),
      skill: discoverSkills(ws, home, { projectSettings }).some((s) => s.name === "triage"),
      search: searchSkills(ws, "triage", home, 12, { projectSettings }).length > 0,
      load: loadSkill(ws, "triage", home, { projectSettings }) !== undefined,
    });
    // Not trusted: only your own settings count, so the plugin stays on.
    expect(found(false)).toEqual({
      command: true,
      agent: true,
      skill: true,
      search: true,
      load: true,
    });
    // Trusted: the project's "off" applies everywhere.
    expect(found(true)).toEqual({
      command: false,
      agent: false,
      skill: false,
      search: false,
      load: false,
    });
  });
});
