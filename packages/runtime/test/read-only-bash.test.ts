import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkedTargetRisk, readOnlyBashHolds } from "../src/read-only-bash.js";

let dir: string;
let ws: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-robash-"));
  ws = join(dir, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "README.md"), "hi\n");
  writeFileSync(join(dir, "secret.txt"), "outside\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const holds = (cmd: string, readDenied?: (p: string) => boolean) =>
  readOnlyBashHolds(cmd, { workspaceRoot: ws, ...(readDenied ? { readDenied } : {}) });

describe.skipIf(process.platform === "win32")("a read-only shell command, checked on disk", () => {
  it("reads inside the workspace run without asking; outside ones ask", () => {
    expect(holds("cat README.md")).toBe(true);
    expect(holds("grep -rn /api/ .")).toBe(true); // a pattern, not a file
    expect(holds(`cat ${join(dir, "secret.txt")}`)).toBe(false);
    expect(holds("cat ../secret.txt")).toBe(false);
    expect(holds(`grep --file=${join(dir, "secret.txt")} README.md`)).toBe(false);
  });
  it("a link inside the workspace that leads outside asks", () => {
    symlinkSync(join(dir, "secret.txt"), join(ws, "notes.txt"));
    expect(holds("cat notes.txt")).toBe(false);
  });
  it("a file your Read deny rules cover asks", () => {
    writeFileSync(join(ws, ".env"), "KEY=1\n");
    expect(holds("cat .env", (p) => p.endsWith("/.env"))).toBe(false);
    expect(holds("cat README.md", (p) => p.endsWith("/.env"))).toBe(true);
  });
  it("git asks when the repository's config names a program git runs by itself", () => {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    expect(holds("git status")).toBe(true);
    execFileSync("git", ["config", "core.fsmonitor", "true"], { cwd: ws });
    expect(holds("git status")).toBe(true); // git's own built-in monitor
    execFileSync("git", ["config", "core.fsmonitor", "./run-me.sh"], { cwd: ws });
    expect(holds("git status")).toBe(false);
    execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: ws });
    execFileSync("git", ["config", "diff.external", "./run-me.sh"], { cwd: ws });
    expect(holds("git diff")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("escapes found in review", () => {
  it("a path is judged where the kernel lands it (link/../x), and a glued option value is a path", () => {
    mkdirSync(join(dir, "outer", "sub"), { recursive: true });
    writeFileSync(join(dir, "outer", "secret.txt"), "x");
    symlinkSync(join(dir, "outer", "sub"), join(ws, "l"));
    expect(holds("cat l/../secret.txt")).toBe(false);
    expect(holds(`file -f${join(dir, "secret.txt")}`)).toBe(false);
    expect(holds(`grep -f${join(dir, "secret.txt")} README.md`)).toBe(false);
    expect(holds("ls -la")).toBe(true);
  });
  it("no folder walk that follows links; with deny rules, no folder walk at all", () => {
    expect(holds("grep -R TODO .")).toBe(false);
    expect(holds("rg --follow TODO")).toBe(false);
    expect(holds("grep -rn TODO .")).toBe(true);
    const denied = (p: string) => p.endsWith("/.env");
    expect(holds("grep -r API_KEY .", denied)).toBe(false);
    expect(holds("rg API_KEY", denied)).toBe(false);
    expect(holds("cat README.md", denied)).toBe(true);
  });
  const repo = () => {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    return (...a: string[]) => execFileSync("git", a, { cwd: ws });
  };
  it("git in a plain repository (even one with commit hooks) stays automatic", () => {
    const git = repo();
    git("config", "remote.origin.url", "https://example.com/x.git");
    git("config", "branch.feature/v1.2.remote", "origin");
    writeFileSync(join(ws, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    expect(holds("git status")).toBe(true);
  });
  it.each([
    [
      "a hook git runs during a read",
      (g: (...a: string[]) => unknown) => {
        writeFileSync(join(ws, ".git", "hooks", "post-index-change"), "#!/bin/sh\n");
        void g;
      },
    ],
    [
      "worktree config",
      (g: (...a: string[]) => unknown) => {
        g("config", "extensions.worktreeConfig", "true");
        g("config", "--worktree", "core.fsmonitor", "./run-me.sh");
      },
    ],
    [
      "a submodule",
      (g: (...a: string[]) => unknown) => {
        void g;
        mkdirSync(join(ws, ".git", "modules", "sub"), { recursive: true });
      },
    ],
    [
      "a gpg program",
      (g: (...a: string[]) => unknown) => g("config", "gpg.program", "./run-me.sh"),
    ],
    [
      "a partial clone",
      (g: (...a: string[]) => unknown) => {
        g("config", "extensions.partialClone", "origin");
        g("config", "remote.origin.uploadpack", "./run-me.sh");
      },
    ],
    [
      "an include file",
      (g: (...a: string[]) => unknown) => g("config", "include.path", "../x.cfg"),
    ],
  ])("git asks with %s", (_name, arrange) => {
    arrange(repo());
    expect(holds("git status")).toBe(false);
    expect(holds("git log --oneline")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("an edit through a symlink", () => {
  it("is judged by the file it really changes", () => {
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, ".git", "config"), "[core]\n");
    symlinkSync(join(ws, ".git", "config"), join(ws, "notes.txt"));
    expect(linkedTargetRisk("edit", { path: "notes.txt" }, ws).join()).toMatch(/\.git\/config/);
    expect(linkedTargetRisk("edit", { path: "README.md" }, ws)).toEqual([]);
    expect(linkedTargetRisk("write", { path: "new-file.ts" }, ws)).toEqual([]);
    // A new file under a folder link, and a dangling link, are judged where they'd be created.
    mkdirSync(join(ws, ".github", "workflows"), { recursive: true });
    symlinkSync(join(ws, ".github", "workflows"), join(ws, "wf"));
    expect(linkedTargetRisk("write", { path: "wf/x.yml" }, ws).join()).toMatch(/workflows/);
    symlinkSync(join(ws, ".git", "hooks-x"), join(ws, "dangling.txt"));
    mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
    rmSync(join(ws, "dangling.txt"));
    symlinkSync(join(ws, ".git", "hooks", "pre-commit"), join(ws, "dangling.txt"));
    expect(linkedTargetRisk("write", { path: "dangling.txt" }, ws).join()).toMatch(/hooks/);
  });
});
