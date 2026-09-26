import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverAgents,
  discoverCommands,
  discoverSkills,
  expandCommand,
  loadMcpConfig,
  parseSkill,
} from "../src/index.js";

let ws: string;
let home: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-eco-ws-"));
  home = await mkdtemp(join(tmpdir(), "amb-eco-home-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});
const write = (dir: string, file: string, content: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
};

describe("loadMcpConfig — unified Claude + Codex", () => {
  it("reads a Claude .mcp.json (wrapped) and a Codex config.toml, project wins on collision", () => {
    write(
      ws,
      ".mcp.json",
      JSON.stringify({ mcpServers: { docs: { command: "docs-server", args: ["--x"] } } }),
    );
    write(
      join(home, ".codex"),
      "config.toml",
      `[mcp_servers.docs]\ncommand="OTHER"\n[mcp_servers.db]\ncommand="db-server"\n`,
    );
    const specs = loadMcpConfig(ws, {}, home);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    expect(byName.docs).toMatchObject({
      transport: "stdio",
      command: "docs-server",
      source: "project",
    });
    expect(byName.db).toMatchObject({ transport: "stdio", command: "db-server", source: "user" });
  });
  it("accepts a BARE .mcp.json, expands ${VAR}, and flags a url server as http", () => {
    write(
      ws,
      ".mcp.json",
      JSON.stringify({ api: { url: "https://${HOST}/mcp" }, local: { command: "${BIN}" } }),
    );
    const specs = loadMcpConfig(ws, { HOST: "example.com", BIN: "/usr/bin/tool" }, home);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    expect(byName.api).toMatchObject({ transport: "http", url: "https://example.com/mcp" });
    expect(byName.local).toMatchObject({ transport: "stdio", command: "/usr/bin/tool" });
  });
  it("ignores an enabled:false server and unsafe names; missing files → []", () => {
    write(
      ws,
      ".mcp.json",
      JSON.stringify({ off: { command: "x", enabled: false }, "bad name": { command: "y" } }),
    );
    expect(loadMcpConfig(ws, {}, home)).toEqual([]);
  });
  it("a disabled higher-precedence entry RESERVES the name (a lower-precedence server can't sneak in)", () => {
    write(ws, ".mcp.json", JSON.stringify({ docs: { command: "x", enabled: false } }));
    write(join(home, ".codex"), "config.toml", `[mcp_servers.docs]\ncommand="global-docs"\n`);
    // Project disabled `docs` must suppress the global `docs` — not silently start it.
    expect(loadMcpConfig(ws, {}, home).find((s) => s.name === "docs")).toBeUndefined();
  });
  it("a bare .mcp.json can define a server literally named `mcpServers`", () => {
    write(ws, ".mcp.json", JSON.stringify({ mcpServers: { command: "x" }, db: { command: "y" } }));
    const names = loadMcpConfig(ws, {}, home)
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(["db", "mcpServers"]); // both bare entries survive (not treated as a wrapper)
  });
  it("a WRAPPED config whose server is named `env` (a would-be marker) still loads that server", () => {
    // Wrapper detection is by the VALUES being server entries — not by a child key named env/enabled/args/type.
    write(ws, ".mcp.json", JSON.stringify({ mcpServers: { env: { command: "server" } } }));
    expect(loadMcpConfig(ws, {}, home).map((s) => s.name)).toEqual(["env"]);
  });
});

describe("ecosystem loaders — symlink + expansion hardening", () => {
  it("does NOT follow a symlinked command file (no arbitrary-file exfiltration)", () => {
    const secret = join(ws, "secret.txt");
    writeFileSync(secret, "TOP SECRET PRIVATE KEY");
    const cmdDir = join(ws, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    symlinkSync(secret, join(cmdDir, "evil.md")); // a committed symlink → a readable private file
    write(cmdDir, "ok.md", "a real command");
    const cmds = discoverCommands(ws, home);
    expect(cmds.find((c) => c.name === "evil")).toBeUndefined(); // the symlink is skipped
    expect(cmds.find((c) => c.name === "ok")).toBeDefined(); // real files still work
    expect(cmds.some((c) => c.body.includes("SECRET"))).toBe(false);
  });
  it("does NOT descend into a symlinked directory", () => {
    const outside = join(home, "outside");
    write(outside, "leak.md", "leaked");
    const cmdDir = join(ws, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    symlinkSync(outside, join(cmdDir, "sub"));
    expect(discoverCommands(ws, home).some((c) => c.name.startsWith("sub:"))).toBe(false);
  });
  it("does NOT follow a symlinked per-skill directory that escapes the skills root (ancestor guard)", () => {
    // A valid SKILL.md sits OUTSIDE the workspace; a committed symlink `skills/evil -> outside` would make
    // `evil/SKILL.md` look like a regular file to a leaf-only check. The ancestor-containment guard rejects it.
    const outside = join(home, "outside-skill");
    write(outside, "SKILL.md", "---\nname: evil\ndescription: leaked\n---\nbody");
    const skillsDir = join(ws, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(outside, join(skillsDir, "evil"));
    expect(discoverSkills(ws, home).some((s) => s.name === "evil")).toBe(false);
  });
  it("a bare {mcpServers:{enabled:false}} is a disabled entry (not a wrapper) and reserves its name", () => {
    write(ws, ".mcp.json", JSON.stringify({ mcpServers: { command: "x", enabled: false } }));
    write(join(home, ".codex"), "config.toml", `[mcp_servers.mcpServers]\ncommand="global"\n`);
    // The disabled bare `mcpServers` must NOT be a wrapper AND must suppress the lower-precedence global one.
    expect(loadMcpConfig(ws, {}, home).find((s) => s.name === "mcpServers")).toBeUndefined();
  });
  it("expandCommand inserts args LITERALLY (no metachar / double expansion)", () => {
    // `$&` must stay literal, and a substituted `$ARGUMENTS`/`$2` must not be re-expanded.
    expect(expandCommand("a $ARGUMENTS b", ["$&"])).toBe("a $& b");
    expect(expandCommand("X $ARGUMENTS Y", ["$2", "SECRET"])).toBe("X $2 SECRET Y");
    expect(expandCommand("$1 then $ARGUMENTS", ["$ARGUMENTS", "z"])).toBe(
      "$ARGUMENTS then $ARGUMENTS z",
    );
  });
});

describe("discoverAgents — Claude .claude/agents → subagent presets", () => {
  it("parses frontmatter, maps Claude tool + model names to ambient", () => {
    write(
      join(ws, ".claude", "agents"),
      "reviewer.md",
      "---\nname: code-reviewer\ndescription: reviews code\ntools: Read, Grep, Bash\nmodel: opus\n---\nYou are a strict reviewer.",
    );
    const [a] = discoverAgents(ws, home);
    expect(a).toMatchObject({ name: "code-reviewer", description: "reviews code", model: "auto" });
    expect(a?.tools).toEqual(["read", "grep", "bash"]);
    expect(a?.body).toContain("strict reviewer");
  });
});

describe("discoverCommands — Claude + Codex slash commands", () => {
  it("discovers commands, namespaces subdirs, and expands $ARGUMENTS/$1", () => {
    write(
      join(ws, ".claude", "commands"),
      "deploy.md",
      "---\ndescription: ship it\n---\nDeploy $1 now: $ARGUMENTS",
    );
    write(join(home, ".codex", "prompts"), "review.md", "Review the diff");
    const cmds = discoverCommands(ws, home);
    const names = cmds.map((c) => c.name).sort();
    expect(names).toContain("deploy");
    expect(names).toContain("review");
    const deploy = cmds.find((c) => c.name === "deploy");
    expect(expandCommand(deploy?.body ?? "", ["prod", "--force"])).toBe(
      "Deploy prod now: prod --force",
    );
  });
});

describe("parseSkill — YAML block scalars (real Claude skills)", () => {
  it("folds a `>-` description into one line instead of storing the literal '>-'", () => {
    const p = parseSkill(
      "---\nname: helper\ndescription: >-\n  first line\n  second line\n---\nbody here",
    );
    expect(p?.meta.description).toBe("first line second line");
    expect(p?.body).toBe("body here");
  });
  it("keeps a literal `|` block's newlines", () => {
    const p = parseSkill("---\nname: h\ndescription: |\n  line one\n  line two\n---\nb");
    expect(p?.meta.description).toBe("line one\nline two");
  });
});

describe("discoverSkills — multi-root (ambient + Claude)", () => {
  it("finds skills in .ambient/skills AND .claude/skills, ambient wins on name collision", () => {
    write(
      join(ws, ".ambient", "skills", "deploy"),
      "SKILL.md",
      "---\nname: deploy\ndescription: ambient one\n---\nA",
    );
    write(
      join(ws, ".claude", "skills", "deploy"),
      "SKILL.md",
      "---\nname: deploy\ndescription: claude dup\n---\nB",
    );
    write(
      join(ws, ".claude", "skills", "review"),
      "SKILL.md",
      "---\nname: review\ndescription: from claude\n---\nC",
    );
    const skills = discoverSkills(ws, home);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s.description]));
    expect(byName.deploy).toBe("ambient one"); // ambient root wins
    expect(byName.review).toBe("from claude"); // a Claude-only skill is discovered
  });
});
