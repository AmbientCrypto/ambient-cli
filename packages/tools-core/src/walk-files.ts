import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Directories never descended into (build output / VCS / deps / caches). Shared by every file-walking tool
 *  (glob, grep, …) so descent rules live in exactly one place. Mirrors the repo-map scan's skip set. */
export const DEFAULT_IGNORE: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** Files never yielded — secrets that must not be enumerated into model context via grep/glob (security).
 *  The model can still `read` a specific non-secret file (e.g. `.env.example`) explicitly; this only bounds
 *  bulk ENUMERATION, which is where a secret leaks by accident. */
/** Secret files a folder search never looks inside (shared with the ripgrep search). */
export const SENSITIVE_FILE =
  /^(\.env(\..+)?|\.netrc|\.pgpass|\.htpasswd|\.npmrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|pfx|p12|keystore|jks|asc))$/i;

interface IgnoreCtx {
  names: ReadonlySet<string>; // dir/file base-names to skip (DEFAULT_IGNORE + plain .gitignore entries)
  suffixes: readonly string[]; // e.g. ".log" from a `*.log` .gitignore line
}

/** Parse the root `.gitignore` for the common cases (plain names, `name/`, `*.ext`); complex glob patterns
 *  (paths, `**`, negations) are skipped in v1 — best-effort, never throws. */
async function loadGitignore(root: string): Promise<IgnoreCtx> {
  const names = new Set(DEFAULT_IGNORE);
  const suffixes: string[] = [];
  let text: string;
  try {
    text = await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return { names, suffixes };
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const bare = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (bare.startsWith("*.") && !bare.slice(2).includes("/") && !bare.slice(2).includes("*")) {
      suffixes.push(bare.slice(1)); // ".ext"
    } else if (bare.length > 0 && !bare.includes("/") && !bare.includes("*")) {
      names.add(bare); // a plain dir/file name (e.g. `dist`, `.env`, `secrets`)
    }
  }
  return { names, suffixes };
}

function skipped(name: string, isDir: boolean, ctx: IgnoreCtx): boolean {
  if (ctx.names.has(name)) return true;
  if (isDir) return false;
  if (SENSITIVE_FILE.test(name)) return true;
  return ctx.suffixes.some((s) => name.endsWith(s));
}

/**
 * Recursively yield workspace-relative FILE paths under `root` (optionally starting at `start`), skipping the
 * ignore set (build/VCS/deps/caches + the root `.gitignore` + secret files) and NEVER traversing a symlink
 * (it could escape the workspace — CRITICAL — or loop infinitely). Honors an AbortSignal so a long walk stops
 * promptly on cancel. One walker for all tools so traversal rules are fixed in exactly one place.
 */
export async function* walkFiles(
  root: string,
  opts: { start?: string; ignore?: ReadonlySet<string>; signal?: AbortSignal } = {},
): AsyncGenerator<string> {
  // An explicit `ignore` override keeps the old contract (names only); otherwise honor .gitignore + secrets.
  const ctx: IgnoreCtx = opts.ignore
    ? { names: opts.ignore, suffixes: [] }
    : await loadGitignore(root);
  yield* walkDir(root, opts.start ?? "", ctx, opts.signal);
}

async function* walkDir(
  root: string,
  dir: string,
  ctx: IgnoreCtx,
  signal: AbortSignal | undefined,
): AsyncGenerator<string> {
  if (signal?.aborted) return;
  let dirents: Dirent[];
  try {
    dirents = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    // Skip a directory we can't read — permission denied (EACCES, e.g. a macOS app-support/crash-dumps dir
    // when the agent is run from $HOME), vanished (ENOENT), or not a directory (ENOTDIR). A single unreadable
    // directory must NOT fail the whole glob/grep; the walk just steps over it and continues.
    return;
  }
  for (const d of dirents) {
    if (signal?.aborted) return;
    if (d.isSymbolicLink()) continue;
    if (skipped(d.name, d.isDirectory(), ctx)) continue;
    const rel = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) yield* walkDir(root, rel, ctx, signal);
    else if (d.isFile()) yield rel;
  }
}
