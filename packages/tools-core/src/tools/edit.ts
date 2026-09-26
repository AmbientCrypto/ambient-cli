import { readFile, writeFile } from "node:fs/promises";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { unifiedDiff } from "../diff.js";
import { sha256 } from "../hash.js";
import { applyHunk } from "../patch.js";
import { resolveInWorkspace } from "../paths.js";

const Input = z.object({
  path: z.string().describe("File to edit, relative to the workspace root"),
  oldString: z.string().describe("Exact text to replace (must be unique unless replaceAll)"),
  newString: z.string().describe("Replacement text"),
  replaceAll: z.boolean().default(false),
  /** Optional guard: the caller's known preimage hash. If set and the file has changed, we refuse. */
  expectPreimageHash: z.string().optional(),
});
const Output = z.object({
  path: z.string(),
  // `edit` always modifies an existing file (it reads the preimage first), so the operation is fixed —
  // carrying it lets the runtime emit the durable `file.mutation` record uniformly with `write`.
  operation: z.literal("modify"),
  replacements: z.number(),
  preimageHash: z.string(),
  postimageHash: z.string(),
  diff: z.string(),
});

export const editTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "edit",
    version: "1",
    description:
      "Replace an exact substring in a file. `oldString` must match uniquely unless replaceAll=true. Conflict-safe.",
    effects: ["write"],
    idempotency: "non-idempotent",
    parallelSafe: false,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 10_000, maximumMs: 15_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const abs = resolveInWorkspace(ctx.workspaceRoot, input.path);
    const before = await readFile(abs, "utf8");
    const preimageHash = sha256(before);
    if (input.expectPreimageHash && input.expectPreimageHash !== preimageHash) {
      throw new Error(
        `file changed since it was read (${input.path}); re-read it before editing (conflict, not overwrite)`,
      );
    }
    const { content: after, replacements } = applyHunk(
      before,
      input.oldString,
      input.newString,
      input.replaceAll,
      input.path,
    );
    ctx.checkpoint?.(before); // save the pre-image for `amb rewind`
    await writeFile(abs, after, "utf8");
    return {
      path: input.path,
      operation: "modify" as const,
      replacements,
      preimageHash,
      postimageHash: sha256(after),
      diff: unifiedDiff(before, after, input.path),
    };
  },
};
