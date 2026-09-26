import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSession, sessionsDir, turnCount } from "@amb/sessions";

/**
 * Resolve a session id from a user argument. `"latest"` (or empty) picks the most-recently-modified session
 * that actually has a user turn (in `workspaceRoot`, when given); anything else must match an existing
 * session id exactly. Shared by `amb resume`, `--continue` and `amb rewind`. Undefined when nothing matches.
 */
export function resolveSessionId(
  idOrLatest: string,
  opts: { workspaceRoot?: string } = {},
): string | undefined {
  const dir = sessionsDir();
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (idOrLatest && idOrLatest !== "latest") return files.find((f) => f.id === idOrLatest)?.id;
  for (const f of files) {
    const { events } = readSession(f.id);
    if (turnCount(events) === 0) continue;
    // `--continue` wants the latest conversation in THIS folder, not the latest anywhere.
    if (opts.workspaceRoot) {
      const root = events.find((e) => e.kind === "session.started")?.workspaceRoot;
      if (root !== opts.workspaceRoot) continue;
    }
    return f.id;
  }
  return undefined;
}
