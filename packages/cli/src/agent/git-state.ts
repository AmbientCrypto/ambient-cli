import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 2000;
const MAX_DIRTY_LINES = 12; // cap the changed-file list so a huge working tree can't blow the prompt

/** Run one read-only git command in `cwd`, returning trimmed stdout or undefined on any failure (not a repo,
 *  git missing, timeout). Never throws — git state is best-effort context, never load-bearing. */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * A compact snapshot of the repo's git state for the system prompt: current branch, the changed-file list
 * (bounded), and the most recent commits. Returns undefined when `cwd` isn't a git work tree, so the caller
 * simply omits the block. Pure read-only git — no fetch, no mutation.
 */
export function gitState(cwd: string): string | undefined {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;

  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)";
  const status = git(cwd, ["status", "--porcelain"]) ?? "";
  const dirty = status.split("\n").filter((l) => l.trim().length > 0);
  const log = git(cwd, ["log", "--oneline", "-5"]) ?? "";

  const dirtyBlock =
    dirty.length === 0
      ? "Working tree: clean"
      : `Changed files (${dirty.length}):\n${dirty.slice(0, MAX_DIRTY_LINES).join("\n")}${
          dirty.length > MAX_DIRTY_LINES ? `\n… +${dirty.length - MAX_DIRTY_LINES} more` : ""
        }`;

  return [`Branch: ${branch}`, dirtyBlock, log ? `Recent commits:\n${log}` : ""]
    .filter(Boolean)
    .join("\n");
}
