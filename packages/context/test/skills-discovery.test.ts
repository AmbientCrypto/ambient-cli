import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverInjectableSkills,
  discoverSkills,
  parseSkill,
  renderRelevantSkills,
  searchSkills,
} from "../src/skills.js";

let dir: string;
let home: string;
let ws: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-skills-"));
  home = join(dir, "home");
  ws = join(dir, "ws");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(ws, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const skill = (root: string, name: string, text: string) => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), text);
};

describe("skill parsing", () => {
  it("uses the folder name and first paragraph when there is no frontmatter", () => {
    const p = parseSkill("# Title\n\nDeploys the app to staging.\n\nMore steps.", "deploy");
    expect(p?.meta).toMatchObject({ name: "deploy", description: "Deploys the app to staging." });
  });
  it("reads the Claude Code skill fields", () => {
    const p = parseSkill(
      "---\nname: release\ndescription: Cuts a release\ndisable-model-invocation: true\nargument-hint: <version>\n---\nsteps",
    );
    expect(p?.meta).toMatchObject({ disableModelInvocation: true, argumentHint: "<version>" });
  });
});

describe("skill discovery", () => {
  it("keeps user-only skills away from the model but still discovers them", () => {
    const root = join(home, ".claude", "skills");
    skill(
      root,
      "release",
      "---\nname: release\ndescription: Cuts a release\ndisable-model-invocation: true\n---\n",
    );
    skill(root, "review", "---\nname: review\ndescription: Reviews a change\n---\n");
    expect(discoverSkills(ws, home).map((s) => s.name)).toContain("release");
    expect(discoverInjectableSkills(ws, home).map((s) => s.name)).not.toContain("release");
    expect(searchSkills(ws, "release", home).map((s) => s.name)).not.toContain("release");
  });
  it("loads only enabled plugins' skills, at the installed version", () => {
    const cache = join(home, ".claude", "plugins", "cache", "mkt");
    skill(
      join(cache, "on", "2.0.0", "skills"),
      "on-skill",
      "---\nname: on-skill\ndescription: enabled\n---\n",
    );
    skill(
      join(cache, "off", "1.0.0", "skills"),
      "off-skill",
      "---\nname: off-skill\ndescription: disabled\n---\n",
    );
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "on@mkt": [{ scope: "user", installPath: join(cache, "on", "2.0.0") }],
          "off@mkt": [{ scope: "user", installPath: join(cache, "off", "1.0.0") }],
        },
      }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "on@mkt": true } }),
    );
    const names = discoverSkills(ws, home).map((s) => s.name);
    expect(names).toContain("on-skill");
    expect(names).not.toContain("off-skill");
  });
  it.skipIf(process.platform === "win32")(
    "follows a symlinked skill folder in the user's own skills",
    () => {
      const repo = join(dir, "repo", "linked");
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "SKILL.md"), "---\nname: linked\ndescription: from a repo\n---\n");
      symlinkSync(repo, join(home, ".claude", "skills", "linked"));
      expect(discoverSkills(ws, home).map((s) => s.name)).toContain("linked");
    },
  );
  it("scans ~/.agents/skills too", () => {
    skill(
      join(home, ".agents", "skills"),
      "agents-skill",
      "---\nname: agents-skill\ndescription: x\n---\n",
    );
    expect(discoverSkills(ws, home).map((s) => s.name)).toContain("agents-skill");
  });
});

describe("skills relevant to a task", () => {
  it("lists matching skills with descriptions, and nothing when none match", () => {
    const skills = [
      { name: "deploy-staging", description: "Deploy the app to staging with checks", path: "/a" },
      { name: "write-tests", description: "Write unit tests with vitest", path: "/b" },
    ];
    const note = renderRelevantSkills(skills, "please deploy this branch to staging");
    expect(note).toContain("deploy-staging: Deploy the app to staging");
    expect(note).not.toContain("write-tests");
    expect(renderRelevantSkills(skills, "hello there")).toBe("");
  });
});
