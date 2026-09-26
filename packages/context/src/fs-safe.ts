import {
  type Stats,
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, sep } from "node:path";

/**
 * Bounded, symlink-safe filesystem reads for the ecosystem loaders (skills / agents / commands / MCP config).
 *
 * These loaders ingest files a *repository* can commit (`.claude/**`, `.mcp.json`, …), so they must not be an
 * exfiltration or memory-DoS vector: a committed symlink `review.md -> ~/.ssh/id_rsa` (or a symlinked ANCESTOR
 * `skills/foo -> /outside`) must never be followed — its bytes would otherwise flow into a prompt / become a
 * task — and a multi-gigabyte config must never be read whole before we bound it.
 *
 * The read is defended two ways at once:
 *   1. the final component is opened with `O_NOFOLLOW`, so a symlinked leaf is rejected atomically;
 *   2. when a containment `root` is given, the file's real (symlink-resolved) parent must stay under the real
 *      root, so a symlinked ancestor that escapes the workspace is rejected too.
 * Size is then read from the OPEN descriptor (`fstat`), closing the lstat→open size-check race.
 */

/** A single ecosystem file over this size is pathological — skip it rather than read it whole. */
export const MAX_ECOSYSTEM_FILE_BYTES = 1_048_576; // 1 MiB

/** At most this many directory entries are considered per scanned root — an unbounded dir can't stall a scan. */
export const MAX_DIR_ENTRIES = 2_000;

/** O_NOFOLLOW where the platform supports it (POSIX); 0 elsewhere (Windows) where we fall back to an lstat check. */
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

export interface SafeReadOpts {
  maxBytes?: number;
  /** If set, the file's real parent directory MUST resolve to within this root (symlinked-ancestor guard). */
  root?: string;
}

/** True when `dir` (after full symlink resolution) is the same as, or nested under, the resolved `root`. */
function withinRoot(root: string, dir: string): boolean {
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = realpathSync(root);
    realDir = realpathSync(dir);
  } catch {
    return false; // a component doesn't exist / can't be resolved ⇒ refuse
  }
  if (realDir === realRoot) return true;
  // A root that already ends in the separator (e.g. "/") must not become "//" — that would reject every child.
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realDir.startsWith(prefix);
}

/**
 * Read a text file IFF it is a real regular file reached without following a symlinked leaf (and, when `root`
 * is given, without a symlinked ancestor escaping that root) and within the size cap; otherwise null. Never throws.
 */
export function readTextCappedSafe(path: string, opts: SafeReadOpts = {}): string | null {
  const maxBytes = opts.maxBytes ?? MAX_ECOSYSTEM_FILE_BYTES;
  if (opts.root && !withinRoot(opts.root, dirname(path))) return null;
  // Platforms without O_NOFOLLOW: reject a symlinked leaf up front (best-effort; there is a small TOCTOU gap
  // on those platforms only — POSIX closes it atomically via O_NOFOLLOW below).
  if (O_NOFOLLOW === 0) {
    try {
      if (lstatSync(path).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW); // ELOOP if the FINAL component is a symlink
  } catch {
    return null; // missing / symlinked-leaf / a directory / permission denied
  }
  try {
    const st: Stats = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** True only if `path` is a real directory (a symlinked dir returns false — no symlink traversal / loops). */
export function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True only if `path` is a real regular file (not a symlink). */
export function isRealFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Read a Markdown file from the user's OWN config folder (e.g. `~/.claude/agents`), following a symlink the
 * user made (agents and skills are often linked in from a repo). Only a regular `.md` target is followed;
 * project folders keep using `readTextCappedSafe`, which never follows links (a cloned repo can't plant one).
 */
export function readUserMarkdown(path: string, opts: { maxBytes?: number } = {}): string | null {
  let target: string;
  try {
    target = realpathSync(path);
  } catch {
    return null;
  }
  if (!target.toLowerCase().endsWith(".md")) return null;
  return readTextCappedSafe(target, {
    ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
    root: dirname(target),
  });
}

/** The nearest folder on `dir`'s path that exists (so containment can be checked before creating the rest). */
function nearestExisting(dir: string): string {
  let d = dir;
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

/**
 * Write a text file IFF it stays inside `root`: a symlinked leaf is never followed (O_NOFOLLOW, or an lstat
 * check where that's unavailable), and a symlinked ancestor that leads out of `root` is refused — checked
 * before any missing folder is created, and again after. The write mirror of `readTextCappedSafe`: a
 * repository can commit `.ambient/MEMORY.md -> ~/.zshrc`, and ambient must not write through it. Returns
 * whether the file was written; never throws.
 */
export function writeTextSafe(path: string, data: string, opts: { root: string }): boolean {
  const dir = dirname(path);
  const existing = nearestExisting(dir);
  // A root that doesn't exist yet (a first note in a new home folder) is created along with the file; then
  // the nearest existing folder above both must be the same one.
  let safeStart: boolean;
  try {
    safeStart = existsSync(opts.root)
      ? withinRoot(opts.root, existing)
      : realpathSync(existing) === realpathSync(nearestExisting(opts.root));
  } catch {
    return false;
  }
  if (!safeStart) return false;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  if (!withinRoot(opts.root, dir)) return false;
  if (O_NOFOLLOW === 0) {
    try {
      if (lstatSync(path).isSymbolicLink()) return false;
    } catch {
      // doesn't exist yet — created below
    }
  }
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW,
      0o644,
    );
  } catch {
    return false; // a symlinked leaf (ELOOP), a directory, or no permission
  }
  try {
    if (!fstatSync(fd).isFile()) return false;
    const buf = Buffer.from(data, "utf8");
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
