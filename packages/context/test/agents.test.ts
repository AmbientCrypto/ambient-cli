import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, parseAgent } from "../src/agents.js";

describe("agent presets", () => {
  it("reads list-form tool names and maps them onto ambient's tools", () => {
    const a = parseAgent(
      '---\nname: reviewer\ndescription: Reviews: carefully\ntools: ["Read", "Grep", "Glob", "WebSearch", "MultiEdit"]\n---\nBe thorough.',
    );
    expect(a?.tools).toEqual(["read", "grep", "glob", "web_search", "apply_patch"]);
    expect(a?.writes).toBe(true); // apply_patch edits files
    expect(a?.body).toBe("Be thorough.");
  });
  it("reports tools ambient doesn't have, and never leaves an agent with zero tools", () => {
    const a = parseAgent("---\nname: x\ntools: NotebookEdit, KillShell\n---\nb");
    expect(a?.tools).toBeUndefined(); // falls back to the role's defaults
    expect(a?.unknownTools).toEqual(["NotebookEdit", "KillShell"]);
  });
  it("read-only presets are recognized; permission-scoped names like Bash(git:*) map to the tool", () => {
    expect(parseAgent("---\nname: r\ntools: Read, Grep\n---\n")?.writes).toBe(false);
    expect(parseAgent("---\nname: g\ntools: Bash(git:*)\n---\n")?.tools).toEqual(["bash"]);
  });
  it("falls back to the file name when frontmatter has no name", () => {
    expect(parseAgent("---\ndescription: d\n---\nb", "my-agent")?.name).toBe("my-agent");
  });
});

describe("discovering agents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amb-agents-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")(
    "follows a symlink in the user's own agents folder, but not in a project's",
    () => {
      const home = join(dir, "home");
      const ws = join(dir, "ws");
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(join(home, ".claude", "agents"), { recursive: true });
      mkdirSync(join(ws, ".claude", "agents"), { recursive: true });
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "linked.md"), "---\nname: linked\n---\nfrom a repo");
      writeFileSync(join(elsewhere, "planted.md"), "---\nname: planted\n---\nsneaky");
      symlinkSync(join(elsewhere, "linked.md"), join(home, ".claude", "agents", "linked.md"));
      symlinkSync(join(elsewhere, "planted.md"), join(ws, ".claude", "agents", "planted.md"));
      const names = discoverAgents(ws, home).map((a) => a.name);
      expect(names).toContain("linked");
      expect(names).not.toContain("planted");
    },
  );
});
