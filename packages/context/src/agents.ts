import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listField, parseFrontmatter, textField } from "./frontmatter.js";
import { MAX_DIR_ENTRIES, isRealDir, readTextCappedSafe, readUserMarkdown } from "./fs-safe.js";
import { installedPlugins } from "./plugins.js";

/**
 * Discover reusable SUBAGENT presets from a user's existing Claude Code setup (`.claude/agents/*.md`) plus
 * ambient's own `.ambient/agents/`. Each file = frontmatter {name, description, tools?, model?} + a body that
 * becomes the child's system prompt. The name/description are UNTRUSTED (flattened+bounded before use);
 * tool + model names are mapped onto ambient equivalents. Best-effort — a bad file is skipped.
 */
export interface AgentPreset {
  name: string;
  description: string;
  /** The system-prompt body for the subagent. */
  body: string;
  /** Ambient tool names this preset restricts the child to (absent ⇒ the role's default tools). */
  tools?: string[];
  /** Tool names the file lists that ambient has no equivalent for (shown as a warning, never fatal). */
  unknownTools?: string[];
  /** Ambient model id (or "auto"). */
  model?: string;
  /** True when the preset may change files (it lists an editing or shell tool) — it runs as a builder. */
  writes: boolean;
}

/** Claude Code tool names → ambient's. Tools that don't exist in ambient are reported, not silently dropped. */
const CLAUDE_TO_AMBIENT_TOOL: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "apply_patch",
  grep: "grep",
  glob: "glob",
  ls: "list",
  bash: "bash",
  webfetch: "web_fetch",
  websearch: "web_search",
  task: "subagent",
  agent: "subagent",
  todowrite: "plan",
  todoread: "plan",
  skill: "skill",
  notebookread: "read",
  askuserquestion: "ask_user",
};
/** Ambient's own tool names, accepted as-is in `.ambient/agents`. */
const AMBIENT_TOOLS = new Set([
  ...Object.values(CLAUDE_TO_AMBIENT_TOOL),
  "list",
  "search_skills",
  "read_artifact",
  "remember",
]);
const WRITING_TOOLS = new Set(["write", "edit", "apply_patch", "bash"]);

function flatten(s: string, max: number): string {
  const f = s
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return f.length > max ? `${f.slice(0, max - 1)}…` : f;
}

function mapModel(m: string | undefined): string | undefined {
  if (!m) return undefined;
  const lower = m.toLowerCase();
  if (lower === "inherit") return undefined;
  // Claude tiers map to "auto" (Ambient auto-picks its best model); an explicit HF-style id passes through.
  if (["opus", "sonnet", "haiku"].includes(lower)) return "auto";
  return m;
}

/** Map a tool list; `mcp__server__tool` names pass through (they're matched against connected servers). */
function mapTools(listed: string[]): { tools: string[]; unknown: string[] } {
  const tools: string[] = [];
  const unknown: string[] = [];
  for (const raw of listed) {
    const name = raw.replace(/\(.*\)$/, "").trim(); // `Bash(git:*)` → Bash
    const mapped = name.startsWith("mcp__")
      ? name
      : (CLAUDE_TO_AMBIENT_TOOL[name.toLowerCase()] ??
        (AMBIENT_TOOLS.has(name.toLowerCase()) ? name.toLowerCase() : undefined));
    if (mapped) {
      if (!tools.includes(mapped)) tools.push(mapped);
    } else if (!unknown.includes(name)) unknown.push(name);
  }
  return { tools, unknown };
}

export function parseAgent(text: string, fallbackName?: string): AgentPreset | null {
  const fm = parseFrontmatter(text);
  if (!fm) return null;
  const name = textField(fm.data, "name") ?? fallbackName;
  if (!name || !/^[a-zA-Z0-9_.:-]+$/.test(name)) return null;
  const listed = listField(fm.data, "tools");
  const mapped = listed ? mapTools(listed) : undefined;
  // A list that names only tools ambient doesn't have falls back to the role's defaults (never zero tools).
  const tools = mapped && mapped.tools.length > 0 ? mapped.tools : undefined;
  const model = mapModel(textField(fm.data, "model"));
  return {
    name,
    description: flatten(textField(fm.data, "description") ?? name, 1_024),
    body: fm.body.length > 16_000 ? fm.body.slice(0, 16_000) : fm.body,
    ...(tools ? { tools } : {}),
    ...(mapped && mapped.unknown.length > 0 ? { unknownTools: mapped.unknown } : {}),
    ...(model ? { model } : {}),
    // No list means "all tools", which includes editing.
    writes: tools ? tools.some((t) => WRITING_TOOLS.has(t)) : true,
  };
}

/** Discover agent presets across roots (project > user), first-wins by name. */
export function discoverAgents(workspaceRoot: string, home: string = homedir()): AgentPreset[] {
  // Project folders never follow symlinks; the user's own ~/.claude/agents may link agents in from elsewhere.
  const roots: Array<{ dir: string; user: boolean; prefix?: string }> = [
    { dir: join(workspaceRoot, ".ambient", "agents"), user: false },
    { dir: join(workspaceRoot, ".claude", "agents"), user: false },
    { dir: join(home, ".claude", "agents"), user: true },
    // Enabled Claude Code plugins' agents, named `plugin:agent` the way Claude Code names them.
    ...installedPlugins(workspaceRoot, home).map((p) => ({
      dir: join(p.root, "agents"),
      user: false,
      prefix: `${p.name}:`,
    })),
  ];
  const byName = new Map<string, AgentPreset>();
  for (const { dir, user, prefix } of roots) {
    if (!isRealDir(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .slice(0, MAX_DIR_ENTRIES);
    } catch {
      continue;
    }
    for (const f of files) {
      // no symlink follow (leaf or ancestor), contained under the agents root, size-bounded
      const text = user
        ? readUserMarkdown(join(dir, f))
        : readTextCappedSafe(join(dir, f), { root: dir });
      if (text === null) continue;
      const parsed = parseAgent(text, f.replace(/\.md$/, ""));
      const preset = parsed && prefix ? { ...parsed, name: `${prefix}${parsed.name}` } : parsed;
      if (preset && !byName.has(preset.name)) byName.set(preset.name, preset);
    }
  }
  return [...byName.values()];
}
