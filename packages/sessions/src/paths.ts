import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Root for all amb session data: ~/.ambient/amb (override with AMB_HOME for tests). */
export function ambHome(env: Record<string, string | undefined> = process.env): string {
  return env.AMB_HOME ?? join(homedir(), ".ambient", "amb");
}

export function sessionsDir(env?: Record<string, string | undefined>): string {
  return join(ambHome(env), "sessions");
}

// A session id must be a single safe filename component — no path separators, no `..`, no null bytes — so a
// user-supplied `ambient sessions show <id>` can never address a JSONL file outside the sessions directory.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True iff `id` is a safe filename component (rejects `../`, absolute paths, separators, empty, null bytes). */
export function isSafeSessionId(id: string): boolean {
  return typeof id === "string" && SAFE_SESSION_ID.test(id) && !id.includes("..");
}

/** Throw a clear error for an unsafe session id — the single validation chokepoint before any FS op. */
export function assertSafeSessionId(id: string): void {
  if (!isSafeSessionId(id)) {
    throw new Error(`invalid session id ${JSON.stringify(id)} — must be a safe filename component`);
  }
}

export function sessionPath(sessionId: string, env?: Record<string, string | undefined>): string {
  assertSafeSessionId(sessionId);
  const dir = sessionsDir(env);
  const path = join(dir, `${sessionId}.jsonl`);
  // Defense in depth: the resolved path must stay strictly inside the sessions directory.
  const root = resolve(dir);
  if (!resolve(path).startsWith(root + sep)) {
    throw new Error(`session id ${JSON.stringify(sessionId)} escapes the sessions directory`);
  }
  return path;
}
