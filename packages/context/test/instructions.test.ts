import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ancestorDirs, loadInstructions } from "../src/instructions.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "amb-instr-"));
  mkdirSync(join(root, ".git"), { recursive: true }); // mark repo root
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ancestorDirs", () => {
  it("stops at the repo root", () => {
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    const dirs = ancestorDirs(sub);
    expect(dirs[0]).toBe(sub);
    expect(dirs.at(-1)).toBe(root); // .git is here
  });
});

describe("loadInstructions", () => {
  it("loads nearest-first, dedupes identical content, records sources", () => {
    writeFileSync(join(root, "AMB.md"), "Root rules: use tabs.");
    const sub = join(root, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "AGENTS.md"), "Package rules: run vitest.");
    const out = loadInstructions(sub);
    expect(out.text).toContain("Package rules");
    expect(out.text).toContain("Root rules");
    expect(out.sources).toHaveLength(2);
    // nearest first
    expect(out.text.indexOf("Package rules")).toBeLessThan(out.text.indexOf("Root rules"));
  });

  it("returns empty when there are no instruction files", () => {
    expect(loadInstructions(root).text).toBe("");
  });

  it("does NOT follow a symlinked instruction file (a committed CLAUDE.md -> secret must not reach the prompt)", () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "TOP-SECRET-KEY-abc123");
    // a repo-committable instruction file that is actually a symlink at the secret
    symlinkSync(secret, join(root, "CLAUDE.md"));
    const out = loadInstructions(root);
    expect(out.text).not.toContain("TOP-SECRET-KEY"); // the symlinked file is skipped, not read into context
    expect(out.sources).toHaveLength(0);
  });
});

describe("Claude Code instruction files", () => {
  it("loads CLAUDE.local.md, .claude/CLAUDE.md and the project's .claude/rules (not path-scoped ones)", () => {
    writeFileSync(join(root, "CLAUDE.local.md"), "Local: my sandbox URL is http://localhost:4000.");
    mkdirSync(join(root, ".claude", "rules", "frontend"), { recursive: true });
    writeFileSync(join(root, ".claude", "CLAUDE.md"), "Team: squash merges only.");
    writeFileSync(
      join(root, ".claude", "rules", "testing.md"),
      "---\ndescription: t\n---\nRule: tests first.",
    );
    writeFileSync(join(root, ".claude", "rules", "frontend", "css.md"), "Rule: no inline styles.");
    writeFileSync(
      join(root, ".claude", "rules", "api.md"),
      "---\npaths:\n  - src/api/**\n---\nRule: only for API files.",
    );
    const out = loadInstructions(root, { perFile: 4000, total: 12000 });
    expect(out.text).toContain("Local: my sandbox URL");
    expect(out.text).toContain("Team: squash merges only.");
    expect(out.text).toContain("# From .claude/rules/testing.md\nRule: tests first.");
    expect(out.text).toContain("# From .claude/rules/frontend/css.md");
    expect(out.text).not.toContain("only for API files");
  });

  it("follows @imports inside the project, depth-limited and each file once", () => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "CLAUDE.md"),
      "See @docs/style.md and @docs/missing.md. Mail me@x.com.",
    );
    writeFileSync(
      join(root, "docs", "style.md"),
      "Style: 2 spaces. Also @./deeper.md and @style.md",
    );
    writeFileSync(join(root, "docs", "deeper.md"), "Deeper: no semicolons. Back to @../CLAUDE.md");
    const out = loadInstructions(root);
    expect(out.text).toContain("## Imported from docs/style.md\nStyle: 2 spaces.");
    expect(out.text).toContain("Deeper: no semicolons.");
    expect(out.text.match(/Style: 2 spaces/g)).toHaveLength(1);
    expect(out.text.match(/See @docs/g)).toHaveLength(1);
  });

  it("never imports outside the project, from code, or through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "amb-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "OUTSIDE-SECRET");
      writeFileSync(join(root, "real.md"), "LINK-TARGET");
      symlinkSync(join(root, "real.md"), join(root, "link.md"));
      writeFileSync(
        join(root, "CLAUDE.md"),
        `Try @${join(outside, "secret.md")} and @../${outside.split("/").at(-1)}/secret.md.\n\n\`@real.md\`\n\n\`\`\`\n@real.md\n\`\`\`\n@link.md`,
      );
      const out = loadInstructions(root);
      expect(out.text).not.toContain("OUTSIDE-SECRET");
      expect(out.text).not.toContain("LINK-TARGET");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("an @path inside an HTML comment is not an import", () => {
    writeFileSync(join(root, "hidden.md"), "HIDDEN-IMPORT");
    writeFileSync(join(root, "CLAUDE.md"), "Rules.\n<!-- @hidden.md -->\n");
    expect(loadInstructions(root).text).not.toContain("HIDDEN-IMPORT");
  });

  it("global Claude Code and Codex files load only when asked, after the project in the budget", async () => {
    const home = await mkdtemp(join(tmpdir(), "amb-home-"));
    try {
      mkdirSync(join(home, ".claude", "rules", "common"), { recursive: true });
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".claude", "CLAUDE.md"), "Global: be brief. @extra.md");
      writeFileSync(join(home, ".claude", "extra.md"), "Extra: from an import.");
      writeFileSync(join(home, ".claude", "rules", "common", "style.md"), "Global rule: tabs.");
      writeFileSync(join(home, ".codex", "AGENTS.md"), "Codex: run tests.");
      writeFileSync(join(root, "AGENTS.md"), "Project: use pnpm.");
      expect(loadInstructions(root, undefined, { home }).text).not.toContain("Global");
      const out = loadInstructions(
        root,
        { perFile: 4000, total: 12000 },
        { home, userFiles: true },
      );
      expect(out.text).toContain("# From ~/.claude/CLAUDE.md\nGlobal: be brief.");
      expect(out.text).toContain("Extra: from an import.");
      expect(out.text).toContain("# From ~/.claude/rules/common/style.md");
      expect(out.text).toContain("Codex: run tests.");
      expect(out.text.indexOf("Global: be brief")).toBeLessThan(
        out.text.indexOf("Project: use pnpm"),
      );
      // A tight budget goes to the project first.
      const tight = loadInstructions(root, { perFile: 4000, total: 40 }, { home, userFiles: true });
      expect(tight.text).toContain("Project: use pnpm.");
      expect(tight.text).not.toContain("Global");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("imports from a project with no repository", () => {
  it("stay inside the working folder — never home, never the filesystem root", async () => {
    const plain = await mkdtemp(join(tmpdir(), "amb-nogit-"));
    const home = await mkdtemp(join(tmpdir(), "amb-nogit-home-"));
    try {
      writeFileSync(join(home, "secret.md"), "HOME-SECRET");
      writeFileSync(join(plain, "notes.md"), "PLAIN-NOTES");
      writeFileSync(
        join(plain, "AGENTS.md"),
        `See @notes.md and @~/secret.md and @${join(home, "secret.md")} and @../${home.split(/[\\/]/).at(-1)}/secret.md`,
      );
      const out = loadInstructions(plain, undefined, { home });
      expect(out.text).toContain("PLAIN-NOTES");
      expect(out.text).not.toContain("HOME-SECRET");
    } finally {
      await rm(plain, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
