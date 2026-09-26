import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveReadable } from "../paths.js";

const Input = z.object({
  path: z.string().default(".").describe("Directory relative to the workspace root"),
});
const Output = z.object({
  path: z.string(),
  entries: z.array(z.object({ name: z.string(), dir: z.boolean() })),
  /** True when the directory simply doesn't exist — a soft, expected result (the model probing for a path),
   *  NOT a tool crash. Rendered calm, not as an alarming red error. */
  notFound: z.boolean().default(false),
});

const IGNORE = new Set([".git", "node_modules", "dist", ".DS_Store"]);

export const listTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "list",
    version: "1",
    description: "List the entries of a directory in the workspace (skips .git/node_modules/dist).",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 10_000, maximumMs: 15_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const abs = resolveReadable(ctx.workspaceRoot, input.path, ctx.readRoots?.list());
    const rel = relative(ctx.workspaceRoot, abs) || ".";
    let dirents: Dirent[];
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      // A missing / non-directory path is an EXPECTED result when the model probes for a path — return a soft
      // not-found instead of throwing (which rendered as an alarming red crash). Anything else re-throws.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { path: rel, entries: [], notFound: true };
      }
      throw err;
    }
    const entries = dirents
      .filter((d) => !IGNORE.has(d.name) && !ctx.readDenied?.(join(abs, d.name)))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { path: rel, entries, notFound: false };
  },
};
