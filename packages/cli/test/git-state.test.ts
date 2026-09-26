import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitState } from "../src/agent/git-state.js";

function run(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "amb-git-"));
  run(repo, ["init", "-q", "-b", "trunk"]);
  run(repo, ["config", "user.email", "test@amb.local"]);
  run(repo, ["config", "user.name", "amb test"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  run(repo, ["add", "a.txt"]);
  run(repo, ["commit", "-q", "-m", "add a.txt"]);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("gitState", () => {
  it("returns undefined outside a git work tree", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "amb-notgit-"));
    try {
      expect(gitState(notRepo)).toBeUndefined();
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("reports the branch and a clean tree with recent commits", () => {
    const s = gitState(repo) ?? "";
    expect(s).toContain("Branch: trunk");
    expect(s).toContain("Working tree: clean");
    expect(s).toContain("Recent commits:");
    expect(s).toContain("add a.txt");
  });

  it("lists changed files when the tree is dirty", () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); // modify tracked
    writeFileSync(join(repo, "b.txt"), "new\n"); // untracked
    const s = gitState(repo) ?? "";
    expect(s).toMatch(/Changed files \(2\)/);
    expect(s).toContain("a.txt");
    expect(s).toContain("b.txt");
    expect(s).not.toContain("Working tree: clean");
  });
});
