import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { readTextCappedSafe, readUserMarkdown } from "./fs-safe.js";

/**
 * Instruction-file discovery (Claude-Code pattern). Walk up from cwd to the repo root, collecting project
 * instruction files in precedence order, then the project's `.claude/rules`, then (when the user opts in)
 * their global Claude Code and Codex instructions. `@path` imports are followed, identical content is
 * deduped, and the total is bounded so project rules never blow the token budget.
 */

// AGENTS.md is the OPEN standard (primary); CLAUDE.md/.clinerules/.goosehints are migrator-compat aliases so
// existing repos work day one (don't invent a proprietary name). AMBIENT.md is our own opt-in.
export const INSTRUCTION_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "CLAUDE.local.md",
  ".clinerules",
  ".goosehints",
  "AMB.md",
  "AMBIENT.md",
  ".ambient/AMBIENT.md",
] as const;
export const MAX_PER_FILE = 4_000;
export const MAX_TOTAL = 12_000;
/** How deep `@path` imports are followed (an import inside an import inside …). */
export const MAX_IMPORT_DEPTH = 5;

function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Whether `dir` is `other` or one of its ancestors. */
function isWithinOrEqual(dir: string, other: string): boolean {
  const rel = relative(dir, other);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Directories from cwd up to (and including) the repo root, or the filesystem root if none. */
export function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let cur = cwd;
  for (;;) {
    dirs.push(cur);
    if (isRepoRoot(cur)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

export interface LoadedInstructions {
  text: string;
  sources: string[];
}

export interface InstructionLimits {
  perFile: number;
  total: number;
}

export interface InstructionOptions {
  /** Also load ~/.claude/CLAUDE.md, ~/.claude/rules and ~/.codex/AGENTS.md. */
  userFiles?: boolean;
  home?: string;
}

type Reader = (path: string) => string | null;

/** Markdown with code fences, inline code and HTML comments blanked out, so an `@name` inside them is never
 *  an import. */
function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

/** The `@path` references in a file's prose (`@docs/style.md`, `@~/notes.md`, `@./x`). */
export function importRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of proseOnly(text).matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.-][\w./-]*)/g)) {
    const ref = (m[1] ?? "").replace(/[.,;:]+$/, "");
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/**
 * A file's text with its `@path` imports appended (recursively, depth-limited, each file at most once).
 * Imports resolve against the importing file's folder (or `~/`) and must stay inside `root` — a project's
 * instructions can pull in its own docs, never files elsewhere on the machine.
 */
function withImports(
  text: string,
  file: string,
  root: string,
  read: Reader,
  home: string,
  seen: Set<string>,
  depth: number,
): string {
  if (depth >= MAX_IMPORT_DEPTH) return text;
  const parts = [text];
  // A project's files import from the project; `~/` is only for the user's own files.
  const fromHome = root === home;
  for (const ref of importRefs(text)) {
    if (ref.startsWith("~/") && !fromHome) continue;
    const target = ref.startsWith("~/") ? join(home, ref.slice(2)) : resolve(dirname(file), ref);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel) || seen.has(target)) continue;
    const content = read(target)?.trim();
    if (!content) continue;
    seen.add(target);
    const nested = withImports(content, target, root, read, home, seen, depth + 1);
    parts.push(`## Imported from ${ref}\n${nested}`);
  }
  return parts.join("\n\n");
}

/** `*.md` files of a rules folder (and its subfolders) that apply everywhere — a rule with `paths:` applies
 *  only while working on matching files, so it isn't loaded up front. */
function ruleFiles(dir: string, read: Reader, depth = 0): Array<{ path: string; text: string }> {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const out: Array<{ path: string; text: string }> = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDir) {
      if (depth < 3 && !e.name.startsWith(".")) out.push(...ruleFiles(path, read, depth + 1));
      continue;
    }
    if (!e.name.toLowerCase().endsWith(".md")) continue;
    const raw = read(path);
    if (raw === null) continue;
    const fm = parseFrontmatter(raw);
    if (fm?.data.paths !== undefined) continue;
    out.push({ path, text: fm ? fm.body : raw });
  }
  return out;
}

/** Load + concatenate instruction files (nearest dir first), deduped and budget-bounded. Limits scale with the
 *  served model (ModelProfile); the defaults are the conservative small-window values. */
export function loadInstructions(
  cwd: string,
  limits: InstructionLimits = { perFile: MAX_PER_FILE, total: MAX_TOTAL },
  opts: InstructionOptions = {},
): LoadedInstructions {
  const home = opts.home ?? homedir();
  const seenContent = new Set<string>();
  const seenFiles = new Set<string>();
  let total = 0;

  const take = (label: string, path: string, raw: string, root: string, read: Reader) => {
    const trimmed = raw.trim();
    if (!trimmed || seenFiles.has(path)) return undefined;
    seenFiles.add(path);
    const full = withImports(trimmed, path, root, read, home, seenFiles, 0);
    const key = trimmed.slice(0, 200);
    if (seenContent.has(key)) return undefined;
    seenContent.add(key);
    const bounded =
      full.length > limits.perFile ? `${full.slice(0, limits.perFile)}\n…(truncated)` : full;
    if (total + bounded.length > limits.total) return undefined; // a later, smaller file may still fit
    total += bounded.length;
    return { text: `# From ${label}\n${bounded}`, path };
  };

  // Project files first: they win the budget. Route through the SAME symlink-safe, size-capped reader every
  // other loader uses (fs-safe): an instruction file is repo-committable and flows into the SYSTEM prompt, so a
  // committed symlink `CLAUDE.md -> ~/.ssh/id_rsa` must NOT be followed (secret exfil).
  const dirs = ancestorDirs(cwd);
  const top = dirs.at(-1) ?? cwd;
  // Imports stay inside the project: the repository when there is one — but never the home folder or above
  // it (no `.git` anywhere walks up to `/`; a home folder can itself be a repo), where the working folder is
  // the limit instead.
  const repoRoot = isRepoRoot(top) && !isWithinOrEqual(top, home) ? top : cwd;
  const projectRead: Reader = (p) => readTextCappedSafe(p, { root: repoRoot });
  const project: Array<{ text: string; path: string }> = [];
  for (const dir of dirs) {
    for (const name of INSTRUCTION_FILENAMES) {
      const path = join(dir, name);
      const content = readTextCappedSafe(path, { root: dir });
      if (content === null) continue;
      const got = take(name, path, content, repoRoot, projectRead);
      if (got) project.push(got);
    }
    if (total >= limits.total) break;
  }
  for (const rule of ruleFiles(join(repoRoot, ".claude", "rules"), projectRead)) {
    const label = `.claude/rules/${relative(join(repoRoot, ".claude", "rules"), rule.path).replace(/\\/g, "/")}`;
    const got = take(label, rule.path, rule.text, repoRoot, projectRead);
    if (got) project.push(got);
  }

  // The user's global instructions come first in the prompt (the project's are more specific) but only get
  // the budget the project left.
  const user: Array<{ text: string; path: string }> = [];
  if (opts.userFiles) {
    const userRead: Reader = (p) => readUserMarkdown(p);
    const globals: Array<[string, string]> = [
      ["~/.claude/CLAUDE.md", join(home, ".claude", "CLAUDE.md")],
      ["~/.codex/AGENTS.md", join(home, ".codex", "AGENTS.md")],
    ];
    for (const [label, path] of globals) {
      const content = userRead(path);
      if (content === null) continue;
      const got = take(label, path, content, home, userRead);
      if (got) user.push(got);
    }
    for (const rule of ruleFiles(join(home, ".claude", "rules"), userRead)) {
      const label = `~/.claude/rules/${relative(join(home, ".claude", "rules"), rule.path).replace(/\\/g, "/")}`;
      const got = take(label, rule.path, rule.text, home, userRead);
      if (got) user.push(got);
    }
  }

  const all = [...user, ...project];
  return { text: all.map((c) => c.text).join("\n\n"), sources: all.map((c) => c.path) };
}

/** The instruction files in exactly one folder (no walking up), bounded — for a subfolder the agent starts
 *  working in, whose rules weren't part of the prompt. Symlink-safe like every other instruction read. */
export function folderInstructions(dir: string, perFile = MAX_PER_FILE): string | undefined {
  const chunks: string[] = [];
  const seen = new Set<string>();
  for (const name of INSTRUCTION_FILENAMES) {
    const content = readTextCappedSafe(join(dir, name), { root: dir })?.trim();
    if (!content) continue;
    const key = content.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    const bounded =
      content.length > perFile ? `${content.slice(0, perFile)}\n…(truncated)` : content;
    chunks.push(`# From ${name}\n${bounded}`);
  }
  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}
