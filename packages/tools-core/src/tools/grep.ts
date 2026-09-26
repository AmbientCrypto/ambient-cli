import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveInWorkspace } from "../paths.js";
import { findRipgrep, isGlob, ripgrepSearch } from "../ripgrep.js";
import { walkFiles } from "../walk-files.js";
import { globToRegExp } from "./glob.js";

const Input = z.object({
  pattern: z.string().describe("Regular expression to search for"),
  path: z.string().default(".").describe("Directory or file to search under (workspace-relative)"),
  glob: z
    .string()
    .optional()
    .describe(
      'Only search matching files: a glob like "*.ts" or "src/**/*.tsx", or a name ending like .ts',
    ),
  limit: z.number().int().positive().default(100),
});
const Match = z.object({ file: z.string(), line: z.number(), text: z.string() });
const Output = z.object({ pattern: z.string(), matches: z.array(Match), truncated: z.boolean() });

const MAX_FILE_BYTES = 2_000_000;
/** Cap the slice of each line the model-supplied regex is tested against — a catastrophic-backtracking
 *  pattern on a very long (e.g. minified) line can hang the synchronous event loop; bounding the input
 *  bounds the worst case. A match past this column on a single line is missed (an accepted grep tradeoff). */
const MAX_LINE_CHARS = 5_000;

export const grepTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "grep",
    version: "1",
    description:
      "Search file contents by regex across the workspace. Returns file:line:text matches.",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 20_000, maximumMs: 45_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const base = resolveInWorkspace(ctx.workspaceRoot, input.path);
    const root = resolveInWorkspace(ctx.workspaceRoot, ".");
    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch (err) {
      throw new Error(`invalid regex: ${(err as Error).message}`);
    }
    const matches: z.infer<typeof Match>[] = [];
    let truncated = false;
    // walkFiles speaks `/`-separated workspace paths on every OS.
    const rootPrefix = base
      .slice(root.length + 1)
      .split(sep)
      .join("/");
    // ripgrep when it's installed (fast, and it honours .gitignore); the JS search otherwise, or when
    // ripgrep can't run this pattern.
    const rg = findRipgrep(root);
    if (rg) {
      const found = await ripgrepSearch({
        rg,
        root,
        start: rootPrefix,
        pattern: input.pattern,
        ...(input.glob ? { glob: input.glob } : {}),
        limit: input.limit,
        maxLineChars: MAX_LINE_CHARS,
        ...(ctx.readDenied ? { denied: ctx.readDenied } : {}),
        signal: ctx.signal,
      });
      if (found) return { pattern: input.pattern, ...found };
    }
    const globRe = input.glob && isGlob(input.glob) ? globToRegExp(input.glob) : undefined;
    const globMatches = (rel: string) =>
      !input.glob ||
      (globRe
        ? globRe.test(input.glob.includes("/") ? rel : (rel.split("/").at(-1) ?? rel))
        : rel.endsWith(input.glob));
    for await (const rel of walkFiles(root, { start: rootPrefix, signal: ctx.signal })) {
      if (!globMatches(rel)) continue;
      if (ctx.readDenied?.(join(root, rel))) continue;
      ctx.signal.throwIfAborted();
      let content: string;
      try {
        const buf = await readFile(join(root, rel));
        if (buf.byteLength > MAX_FILE_BYTES) continue;
        content = buf.toString("utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/); // `$` anchors work on CRLF files too
      for (let i = 0; i < lines.length; i++) {
        const full = lines[i] ?? "";
        const text = full.length > MAX_LINE_CHARS ? full.slice(0, MAX_LINE_CHARS) : full;
        if (re.test(text)) {
          matches.push({ file: rel, line: i + 1, text: text.slice(0, 400) });
          if (matches.length >= input.limit) {
            truncated = true;
            return { pattern: input.pattern, matches, truncated };
          }
        }
      }
    }
    return { pattern: input.pattern, matches, truncated };
  },
};
