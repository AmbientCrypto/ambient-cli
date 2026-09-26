// A best-effort "a newer version is available" check, like Claude Code's update banner. It never blocks the
// CLI and never throws: on any failure (offline, rate-limited, timeout) it silently returns null. The result
// is cached so at most one network call happens per CACHE_TTL_MS. The only thing fetched is a version STRING
// (the latest release tag), which is compared as semver and shown to the user — never executed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CURRENT_VERSION } from "./version.js";

const LATEST_URL = "https://api.github.com/repos/AmbientCrypto/ambient-cli/releases/latest";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // re-check the network at most once every 6 hours

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

/** Parse "1.2.3" (or "v1.2.3") → [1,2,3]; null if it isn't a clean 3-part semver (e.g. "dev"). */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True iff `latest` is a strictly higher semver than `current`. A non-semver current ("dev") is never behind. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  const [al, am, ap] = a;
  const [bl, bm, bp] = b;
  if (al !== bl) return al > bl;
  if (am !== bm) return am > bm;
  return ap > bp;
}

interface Cache {
  checkedAt: number;
  latest: string;
}

function cacheFile(cacheDir?: string): string {
  const base = cacheDir ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "amb", "update-check.json");
}

function readCache(path: string): Cache | undefined {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (typeof c?.checkedAt === "number" && typeof c?.latest === "string") return c;
  } catch {
    // A missing / malformed cache is normal — just re-check.
  }
  return undefined;
}

function writeCache(path: string, c: Cache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(c));
  } catch {
    // A read-only cache dir must never break the CLI — the check just won't be cached.
  }
}

/** Fetch the latest published version tag from GitHub releases. Best-effort: null on any failure/timeout. */
export async function fetchLatestVersion(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(LATEST_URL, {
      headers: { "User-Agent": "ambient-cli", Accept: "application/vnd.github+json" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    return typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

export interface UpdateCheckDeps {
  now?: () => number;
  cacheDir?: string;
  /** Injectable fetcher (tests pass a stub so no real network is hit). */
  fetchLatest?: (signal?: AbortSignal) => Promise<string | null>;
  env?: Record<string, string | undefined>;
  /** From config `checkUpdates` — false disables the check entirely. Default enabled. */
  enabled?: boolean;
  timeoutMs?: number;
  /** The installed version to compare against. Defaults to the build-injected CURRENT_VERSION. */
  current?: string;
}

/**
 * Best-effort update check. Returns UpdateInfo (incl. `updateAvailable`) or null when it can't tell or is
 * disabled. Cached to at most one network call per CACHE_TTL_MS; silent on any failure — never blocks or throws.
 */
export async function checkForUpdate(deps: UpdateCheckDeps = {}): Promise<UpdateInfo | null> {
  const env = deps.env ?? process.env;
  // Off when the user opted out (config or env), and in CI (a build box doesn't need an upgrade nag).
  if (deps.enabled === false || env.AMBIENT_NO_UPDATE_CHECK || env.CI) return null;
  const current = deps.current ?? CURRENT_VERSION;
  if (!parseSemver(current)) return null; // "dev" / un-bundled — nothing meaningful to compare against
  const now = deps.now ?? Date.now;
  const path = cacheFile(deps.cacheDir);
  const cached = readCache(path);
  let latest: string | null = null;
  if (cached && now() - cached.checkedAt < CACHE_TTL_MS) {
    latest = cached.latest; // fresh cache → no network
  } else {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? 2500);
    try {
      latest = await (deps.fetchLatest ?? fetchLatestVersion)(ac.signal);
    } finally {
      clearTimeout(timer);
    }
    if (latest) writeCache(path, { checkedAt: now(), latest });
    else if (cached) latest = cached.latest; // a failed fetch falls back to a stale cache
  }
  if (!latest) return null;
  return { current, latest, updateAvailable: isNewer(latest, current) };
}

/** How this binary was installed, inferred from the running script path — so the upgrade hint gives the RIGHT
 *  command. Homebrew runs from a Cellar/…/homebrew path; an npm global install from a node_modules folder
 *  (the Windows and Linux install path); anything else is a source / dev build. */
export type InstallKind = "brew" | "npm" | "source";
export function installKind(execPath: string = process.argv[1] ?? ""): InstallKind {
  const p = execPath.replace(/\\/g, "/");
  if (/\/(Cellar|homebrew|linuxbrew)\//.test(p)) return "brew";
  if (/\/node_modules\/ambient-code\//.test(p)) return "npm";
  return "source";
}

/** The command a user runs to update, matched to how they installed. */
export function updateCommand(kind: InstallKind = installKind()): string {
  if (kind === "brew") return "brew upgrade ambient-code";
  if (kind === "npm") return "npm install -g ambient-code@latest";
  return "git pull && ./scripts/install.sh";
}

/** The one-line upgrade hint shown when an update is available, with the install-appropriate command. */
export function updateHint(info: UpdateInfo, kind: InstallKind = installKind()): string {
  return `ambient ${info.latest} is available (you have ${info.current}) — run: ${updateCommand(kind)}`;
}
