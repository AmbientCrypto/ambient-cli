import { join } from "node:path";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveInWorkspace } from "../paths.js";
import { walkFiles } from "../walk-files.js";

const Input = z.object({
  pattern: z.string().describe("Glob-ish pattern, e.g. **/*.ts or src/*.json"),
  limit: z.number().int().positive().default(200),
});
const Output = z.object({
  pattern: z.string(),
  matches: z.array(z.string()),
  truncated: z.boolean(),
  /** True when the walk hit its soft time budget before finishing — matches so far are still returned (a
   *  legible "searched a lot, here's what I found" instead of a hard 30s timeout error). */
  timedOut: z.boolean().default(false),
});

/** Soft wall-clock budget for the walk; on exceeding it glob returns the matches gathered so far + timedOut,
 *  so a huge/slow tree can never hit the 30s hard-abort that surfaced as an alarming red error. */
const SOFT_BUDGET_MS = 8_000;

// The literal leading directory of a pattern — the segments before the first wildcard — so the walk can START
// there instead of scanning the whole workspace. "src/tui/<star><star>" starts at "src/tui"; a pattern that
// begins with a wildcard starts at "" (root). This also lets a pattern that names an ignored dir (e.g.
// "node_modules/ink/build/<star><star>") descend into it, because the walk begins INSIDE it rather than being
// pruned at the ignore check.
export function patternStart(pattern: string): string {
  const segs = pattern.split("/");
  const literal: string[] = [];
  for (const s of segs) {
    if (s.includes("*") || s.includes("?")) break;
    literal.push(s);
  }
  // Drop the last literal segment if it's the FINAL one (it's a filename, not a dir to descend into).
  if (literal.length === segs.length) literal.pop();
  return literal.join("/");
}

/** Translate a simple glob (`**`, `*`, `?`) into a RegExp anchored to the whole relative path. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c && "\\^$.|+()[]{}".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export const globTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "glob",
    version: "1",
    description:
      "Find files matching a glob pattern (supports ** and *). Paths are workspace-relative.",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 15_000, maximumMs: 30_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const root = resolveInWorkspace(ctx.workspaceRoot, ".");
    // A leading "/" is NOT the filesystem root here — paths are workspace-relative; strip it so the pattern
    // (and its regex, which is anchored to no-leading-slash walk paths) can actually match.
    // Windows users (and models) may write `src\**\*.ts`; walk paths always use `/`.
    const pattern = (
      process.platform === "win32" ? input.pattern.replace(/\\/g, "/") : input.pattern
    ).replace(/^\/+/, "");
    const re = globToRegExp(pattern);
    const start = patternStart(pattern);
    const matches: string[] = [];
    let truncated = false;
    let timedOut = false;
    const deadline = Date.now() + SOFT_BUDGET_MS;
    let scanned = 0;
    for await (const rel of walkFiles(root, { start, signal: ctx.signal })) {
      scanned += 1;
      // Check the soft budget periodically (cheap) so a pathological tree returns partials, not a 30s error.
      if ((scanned & 2047) === 0 && Date.now() > deadline) {
        truncated = true;
        timedOut = true;
        break;
      }
      if (re.test(rel) && !ctx.readDenied?.(join(root, rel))) {
        matches.push(rel);
        if (matches.length >= input.limit) {
          truncated = true;
          break;
        }
      }
    }
    matches.sort();
    return {
      pattern: input.pattern,
      matches, // already workspace-relative with `/` separators on every OS
      truncated,
      timedOut,
    };
  },
};
