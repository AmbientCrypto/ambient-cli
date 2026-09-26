import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const MAX_SYMLINK_DEPTH = 40;

/**
 * Resolve a possibly-relative path against the workspace root and return a CANONICAL absolute path that
 * is guaranteed to stay inside the workspace — resolving EVERY symlink component (existing, intermediate,
 * chained, or dangling) and checking containment at each step. Throws on any escape.
 *
 * A lexical or one-level check is not enough: `a -> b -> /outside`, or a dangling intermediate symlink,
 * both escape a naive check. We walk root→target segment by segment; whenever a component is a symlink we
 * fully resolve its target (recursively) and re-verify containment before continuing.
 */
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const typedRoot = resolve(workspaceRoot);
  const rootReal = realpathSyncSafe(typedRoot);
  const input = WIN ? (fromGitBashPath(p) ?? p) : p;
  let abs = isAbsolute(input) ? resolve(input) : resolve(rootReal, input);
  // An absolute path may be spelled through the root AS TYPED rather than its real path (macOS /var →
  // /private/var, a Windows junction or 8.3 short name): rebase it onto the real root before checking.
  if (!contains(rootReal, abs) && contains(typedRoot, abs)) {
    abs = rootReal + abs.slice(typedRoot.length);
  }
  if (!contains(rootReal, abs)) throw new Error(`path escapes the workspace: ${p}`);
  if (WIN && relativeSegments(rootReal, abs).some(isReservedWindowsSegment)) {
    throw new Error(`reserved Windows file name or stream in path: ${p}`);
  }
  return resolveChecked(rootReal, abs, 0);
}

const WIN = process.platform === "win32";

/**
 * Resolve a path for READING: inside the workspace, or inside a folder this run was granted read access to
 * (a loaded skill's own files). Each candidate root gets the same symlink-safe containment check.
 */
export function resolveReadable(
  workspaceRoot: string,
  p: string,
  readRoots: readonly string[] = [],
): string {
  try {
    return resolveInWorkspace(workspaceRoot, p);
  } catch (err) {
    if (isAbsolute(p)) {
      for (const root of readRoots) {
        try {
          return resolveInWorkspace(root, p);
        } catch {
          // not under this root
        }
      }
    }
    throw err;
  }
}

/** Git Bash / MSYS spelling of a Windows path (`/c/Users/x`) → `C:\Users\x`; undefined for anything else. */
export function fromGitBashPath(p: string): string | undefined {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  if (!m?.[1]) return undefined;
  return `${m[1].toUpperCase()}:${(m[2] ?? "\\").replace(/\//g, "\\")}`;
}

/** A Windows device name (CON, NUL, COM1, …, with any extension) or an alternate data stream (`a.txt:s`). */
export function isReservedWindowsSegment(segment: string): boolean {
  if (segment.includes(":")) return true;
  const stem = (segment.split(".")[0] ?? "").toUpperCase();
  return /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])$/.test(
    stem,
  );
}

/**
 * Resolve `target` (assumed lexically inside `rootReal`) by walking its components from the root,
 * following symlinks and verifying containment at every step. Returns the canonical resolved path.
 */
function resolveChecked(rootReal: string, target: string, depth: number): string {
  if (depth > MAX_SYMLINK_DEPTH) throw new Error("symlink resolution too deep (possible loop)");
  const segments = relativeSegments(rootReal, target);
  let cur = rootReal;
  for (let i = 0; i < segments.length; i++) {
    const next = `${cur}${sep}${segments[i]}`;
    if (!contains(rootReal, next)) throw new Error(`path escapes the workspace: ${target}`);
    const link = symlinkTargetIfAny(next);
    if (link === undefined) {
      // Not a symlink (or does not exist yet). If it doesn't exist, the remaining segments can't be
      // symlinks either — append them lexically, re-checking containment, and finish.
      cur = next;
      if (!existsPath(next)) {
        for (let j = i + 1; j < segments.length; j++) {
          cur = `${cur}${sep}${segments[j]}`;
          if (!contains(rootReal, cur)) throw new Error(`path escapes the workspace: ${target}`);
        }
        return cur;
      }
    } else {
      const linkTarget = isAbsolute(link) ? link : resolve(cur, link);
      if (!contains(rootReal, linkTarget))
        throw new Error(`path escapes the workspace via a symlink: ${target}`);
      // Fully resolve the (possibly chained / dangling) link target, then continue from there.
      cur = resolveChecked(rootReal, linkTarget, depth + 1);
      if (!contains(rootReal, cur))
        throw new Error(`path escapes the workspace via a symlink: ${target}`);
    }
  }
  return cur;
  // NOTE: residual check/use TOCTOU remains (another process could swap a component to a symlink between
  // this resolution and the fs op). The local single-user CLI threat model accepts this; full closure
  // needs O_NOFOLLOW at open time.
}

/** Segments of `target` relative to `root` (target must be lexically inside root). */
function relativeSegments(root: string, target: string): string[] {
  if (target === root) return [];
  const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return target
    .slice(withSep.length)
    .split(sep)
    .filter((s) => s.length > 0 && s !== ".");
}

/** If `p` is a symlink (even dangling), return its raw link target; otherwise undefined. */
function symlinkTargetIfAny(p: string): string | undefined {
  try {
    if (lstatSync(p).isSymbolicLink()) return readlinkSync(p);
  } catch {
    // does not exist — not a symlink
  }
  return undefined;
}

function existsPath(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function contains(root: string, target: string): boolean {
  // Windows paths are case-insensitive (C:\Proj and c:\proj are the same folder).
  const r = WIN ? root.toLowerCase() : root;
  const t = WIN ? target.toLowerCase() : target;
  const withSep = r.endsWith(sep) ? r : `${r}${sep}`;
  return t === r || t.startsWith(withSep);
}

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync.native(p); // native also expands Windows 8.3 short names
  } catch {
    return p;
  }
}
