import { readFile, writeFile } from "node:fs/promises";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { unifiedDiff } from "../diff.js";
import { sha256 } from "../hash.js";
import { applyHunk } from "../patch.js";
import { resolveInWorkspace } from "../paths.js";

const EditSpec = z.object({
  path: z.string().describe("File to edit, relative to the workspace root"),
  oldString: z
    .string()
    .describe("Exact text to replace (must be unique in the file unless replaceAll)"),
  newString: z.string().describe("Replacement text"),
  replaceAll: z.boolean().default(false),
});
const Input = z.object({
  edits: z
    .array(EditSpec)
    .min(1)
    .max(50)
    .describe(
      "Ordered list of edits across one or more files. Hunks to the SAME file apply in sequence (each matched against the file as updated by the previous hunk). ATOMIC: if ANY hunk fails to match, NOTHING is written.",
    ),
});
const FileResult = z.object({
  path: z.string(),
  operation: z.literal("modify"),
  replacements: z.number(),
  preimageHash: z.string(),
  postimageHash: z.string(),
  diff: z.string(),
});
const Output = z.object({
  files: z.array(FileResult),
  edits: z.number(),
});

/**
 * `apply_patch` — one VALIDATED multi-hunk / multi-file edit primitive (aider edit-pipeline). It
 * applies several exact-substring edits across files ATOMICALLY: every hunk is matched + applied in-memory
 * FIRST; only if ALL succeed does anything get written — so a patch never leaves the workspace half-edited.
 * Same conflict-safe primitive as `edit` (applyHunk): exact unique match, never a fuzzy guess. Modifies
 * existing files only (use `write` for new files).
 */
export const applyPatchTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "apply_patch",
    version: "1",
    description:
      "Apply several exact-substring edits across one or more files in one atomic call. Each edit is {path, oldString, newString, replaceAll?}. All hunks are validated first; if any fails to match, NOTHING is written. Use `edit` for a single change and `write` for a new file.",
    effects: ["write"],
    idempotency: "non-idempotent",
    parallelSafe: false,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 15_000, maximumMs: 30_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    // Group edits by the file they really change (`a.txt` and `./a.txt` are one file), preserving order and
    // the first spelling for display.
    const byFile = new Map<string, { path: string; edits: z.infer<typeof EditSpec>[] }>();
    for (const e of input.edits) {
      const abs = resolveInWorkspace(ctx.workspaceRoot, e.path);
      const group = byFile.get(abs) ?? { path: e.path, edits: [] };
      group.edits.push(e);
      byFile.set(abs, group);
    }

    // Phase 1 — VALIDATE + build the new content for every file in memory (no writes). Any hunk failure here
    // throws and aborts the whole patch, so a partial application can never reach disk.
    const staged: {
      path: string;
      abs: string;
      before: string;
      after: string;
      replacements: number;
    }[] = [];
    for (const [abs, { path, edits }] of byFile) {
      const before = await readFile(abs, "utf8");
      let content = before;
      let replacements = 0;
      for (const e of edits) {
        const r = applyHunk(content, e.oldString, e.newString, e.replaceAll, path);
        content = r.content;
        replacements += r.replacements;
      }
      staged.push({ path, abs, before, after: content, replacements });
    }

    // Phase 2 — write all validated files.
    const files = [];
    for (const s of staged) {
      ctx.checkpoint?.(s.before); // save each file's pre-image for `amb rewind`
      await writeFile(s.abs, s.after, "utf8");
      files.push({
        path: s.path,
        operation: "modify" as const,
        replacements: s.replacements,
        preimageHash: sha256(s.before),
        postimageHash: sha256(s.after),
        diff: unifiedDiff(s.before, s.after, s.path),
      });
    }
    return { files, edits: input.edits.length };
  },
};
