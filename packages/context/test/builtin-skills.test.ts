import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinSkillBody } from "../src/builtin-skills.js";
import {
  discoverInjectableSkills,
  discoverSkills,
  loadSkillBody,
  skillSource,
} from "../src/skills.js";

let ws: string;
let home: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-bskill-ws-"));
  home = mkdtempSync(join(tmpdir(), "amb-bskill-home-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("built-in skills", () => {
  it("the github skill is always discoverable + injectable, even with no user skills", () => {
    const inject = discoverInjectableSkills(ws, home);
    const gh = inject.find((s) => s.name === "github");
    expect(gh).toBeDefined();
    expect(gh?.description.toLowerCase()).toContain("github");
    expect(skillSource(gh?.path ?? "")).toBe("builtin");
  });

  it("its body loads on demand (the embedded practices, not a filesystem read)", () => {
    const body = loadSkillBody(ws, "github", home);
    expect(body).toBe(builtinSkillBody("github"));
    expect(body).toContain("gh auth status");
    expect(body).toContain("conventional commits");
    expect(body).toContain("force-with-lease");
  });

  it("a USER skill of the same name overrides the built-in", () => {
    const dir = join(home, ".claude", "skills", "github");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: github\ndescription: my own github skill\n---\nMY CUSTOM BODY\n",
    );
    const all = discoverSkills(ws, home);
    const ghs = all.filter((s) => s.name === "github");
    expect(ghs.length).toBe(1); // deduped — one github, and it's the user's
    expect(ghs[0]?.description).toBe("my own github skill");
    expect(loadSkillBody(ws, "github", home)).toContain("MY CUSTOM BODY");
  });
});
