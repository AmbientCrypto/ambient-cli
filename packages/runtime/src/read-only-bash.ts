import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyToolRisk, isWithinWorkspace, parseShellCommands } from "@amb/permissions";
import { fromGitBashPath } from "@amb/tools-core";

/**
 * The checks that need the disk, for a shell command the classifier already judged read-only (so it runs
 * without asking, even in plan mode). The classifier only sees text; this confirms the command also:
 *  - reads nothing outside the workspace, resolving paths the way the kernel will (through symlinks, so
 *    `link/../secret` is judged where it really lands) — including an option's glued value (`-f/etc/x`),
 *  - doesn't follow symlinks while walking folders (`grep -R`, `rg --follow`, `tree -l`),
 *  - reads nothing your Read deny rules cover, and with such rules in place walks no folder at all,
 *  - touches no credential file (the risk check's own list),
 *  - isn't git in a repository that could make git run a program by itself: read-time hooks, submodules, any
 *    repository setting beyond a short list of inert ones (a clone that comes with its `.git` folder can
 *    set fsmonitor, diff drivers, gpg programs, filters, include files…).
 * Anything it can't confirm keeps the command's full effects, so it asks.
 */
export function readOnlyBashHolds(
  command: string,
  ctx: { workspaceRoot: string; readDenied?: (absPath: string) => boolean },
): boolean {
  if (classifyToolRisk("bash", { command }).level !== "none") return false;
  const root = ctx.workspaceRoot;
  for (const seg of parseShellCommands(command)) {
    const name = seg.argv[0]?.split("/").pop() ?? "";
    const args = seg.argv.slice(1);
    if (FOLLOWS_LINKS[name]?.(args)) return false;
    if (ctx.readDenied && walksFolders(name, args, root)) return false;
    for (const word of args) {
      for (const value of pathsIn(word)) {
        if (!readsWithinWorkspace(value, root, ctx.readDenied)) return false;
      }
    }
    if (name === "git" && !gitIsInert(root, ctx.readDenied !== undefined, args)) return false;
  }
  return true;
}

/** What a word could name as a path: itself, an option's `=value`, or a short option's glued value. */
function pathsIn(word: string): string[] {
  if (!word.startsWith("-")) {
    // `git show REV:path` names a file too.
    const colon = /^[^:/]+:(.+)$/.exec(word)?.[1];
    return colon ? [word, colon] : [word];
  }
  const eq = word.indexOf("=");
  if (eq >= 0) return [word.slice(eq + 1)];
  // `-f/etc/x`: everything after the first letter may be the option's value.
  return /^-[A-Za-z]./.test(word) ? [word.slice(2)] : [];
}

/** Options that make a command follow symlinks while it walks folders (out of the workspace). */
const FOLLOWS_LINKS: Record<string, (args: string[]) => boolean> = {
  grep: (a) => a.some((w) => /^-[A-Za-z]*[RSO]/.test(w) || w === "--dereference-recursive"),
  rg: (a) => a.some((w) => /^-[A-Za-z]*L/.test(w) || w === "--follow"),
  tree: (a) => a.some((w) => /^-[A-Za-z]*l/.test(w)),
  ls: (a) => a.some((w) => /^-[A-Za-z]*[LR]/.test(w)),
  du: (a) => a.some((w) => /^-[A-Za-z]*L/.test(w)),
};

/** Whether the command reads through folders (so it could reach a denied file without naming it). */
function walksFolders(name: string, args: string[], root: string): boolean {
  if (name === "rg" || name === "tree" || name === "du" || name === "find") return true;
  if (name === "grep" && args.some((w) => /^-[A-Za-z]*r/.test(w) || w === "--recursive"))
    return true;
  return args.some((w) => {
    if (w.startsWith("-")) return false;
    try {
      return statSync(physical(root, w)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * A path as the kernel resolves it: each existing component through its symlinks, then `..` from THERE —
 * so `link/../x` lands next to the link's target, not next to the link.
 */
export function physical(root: string, word: string): string {
  const native = process.platform === "win32" ? (fromGitBashPath(word) ?? word) : word;
  const abs = isAbsolute(native);
  const start = abs ? (process.platform === "win32" ? native.slice(0, 3) : sep) : root;
  let cur = realOrSelf(start);
  for (const part of (abs ? native.slice(start.length) : native).split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    cur = part === ".." ? dirname(cur) : realOrSelf(join(cur, part));
  }
  return cur;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** False when `word`, read as a path, reaches outside the workspace or something you denied. */
function readsWithinWorkspace(
  word: string,
  root: string,
  readDenied?: (absPath: string) => boolean,
): boolean {
  const real = physical(root, word);
  // Nothing there to read: a search pattern (`/api/`), a revision, a missing file.
  if (!existsSync(real)) return true;
  const realRoot = realOrSelf(root);
  if (!isWithinWorkspace(realRoot, real)) return false;
  if (readDenied && (readDenied(real) || readDenied(resolve(root, relative(realRoot, real)))))
    return false;
  return true;
}

/** Repository settings that name no program — anything else in the repository's own config asks. */
const INERT_GIT_KEYS =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|hookspath)|remote\..+\.(url|fetch|pushurl|tagopt|prune|gh-resolved)|branch\..+\.(remote|merge|rebase|pushremote|vscode-merge-base|description)|user\.(name|email|signingkey)|init\.defaultbranch|pull\.(rebase|ff)|push\.(default|autosetupremote)|fetch\.prune|color\.[a-z.]+|advice\.[a-z]+|gc\.auto|lfs\.repositoryformatversion)$/;

/** Hooks git runs during a read (status refreshes and rewrites the index). */
const READ_TIME_HOOKS = ["post-index-change", "reference-transaction"];

/**
 * Whether git can run here without anything the repository supplies being executed: no hook git runs
 * during a read (post-index-change, reference-transaction), no submodules, and only inert settings in the repository's own config and
 * worktree config (include files, extensions and every program-naming key fall outside the list).
 * With Read deny rules, only `git status`/`branch` stay automatic — the rest print file contents.
 */
export function gitIsInert(cwd: string, hasDenyRules = false, args: string[] = []): boolean {
  if (hasDenyRules && !["status", "branch"].includes(args[0] ?? "")) return false;
  const git = (a: string[]) =>
    spawnSync("git", a, { cwd, encoding: "utf8", timeout: 5_000, windowsHide: true });
  const hooks = git(["rev-parse", "--git-path", "hooks"]);
  if (hooks.error || hooks.status !== 0) return false; // not a repository we can check → ask
  try {
    const present = readdirSync(resolve(cwd, hooks.stdout.trim()));
    if (READ_TIME_HOOKS.some((h) => present.includes(h))) return false;
  } catch {
    // no hooks folder: nothing to run
  }
  const common = git(["rev-parse", "--git-common-dir"]);
  if (common.status !== 0) return false;
  if (existsSync(join(resolve(cwd, common.stdout.trim()), "modules"))) return false;
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status === 0 && existsSync(join(top.stdout.trim(), ".gitmodules"))) return false;
  const cfg = git(["config", "--show-scope", "--includes", "--list"]);
  if (cfg.error || cfg.status !== 0) return false;
  for (const line of cfg.stdout.split("\n")) {
    const m = /^(\w+)\t([^=]+)(?:=(.*))?$/.exec(line);
    if (!m) continue;
    const [, scope, key = "", value = ""] = m;
    if (scope !== "local" && scope !== "worktree") continue;
    // `core.fsmonitor true` is git's own built-in monitor, not a program.
    if (key.toLowerCase() === "core.fsmonitor" && /^(true|false)$/i.test(value)) continue;
    if (!INERT_GIT_KEYS.test(key.toLowerCase())) return false;
  }
  return true;
}

/**
 * The risk of a file edit judged by where its paths really lead: a committed symlink `notes.txt ->
 * .git/config`, a dangling one, or a folder link `wf -> .github/workflows` with a new file under it must
 * get the same "writes a sensitive file" check as naming the real place.
 */
export function linkedTargetRisk(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): string[] {
  if (!["write", "edit", "apply_patch", "notebook_edit"].includes(toolName)) return [];
  const spelled: string[] = [];
  if (typeof args.path === "string") spelled.push(args.path);
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) {
      const p = (e as { path?: unknown } | null)?.path;
      if (typeof p === "string") spelled.push(p);
    }
  }
  const realRoot = realOrSelf(workspaceRoot);
  const real = spelled.flatMap((p) => {
    let target = physical(workspaceRoot, p);
    // A dangling link: the write would create the file where it points.
    try {
      if (lstatSync(target).isSymbolicLink())
        target = resolve(dirname(target), readlinkSync(target));
    } catch {
      // doesn't exist yet
    }
    const rel = relative(realRoot, target).split("\\").join("/");
    return rel && rel !== p ? [rel] : [];
  });
  if (real.length === 0) return [];
  return classifyToolRisk("write", { edits: real.map((path) => ({ path })) }).reasons;
}
