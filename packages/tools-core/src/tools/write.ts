import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { unifiedDiff } from "../diff.js";
import { sha256 } from "../hash.js";
import { matchLineEndings } from "../patch.js";
import { resolveInWorkspace } from "../paths.js";

const Input = z.object({
  path: z.string().describe("File path relative to the workspace root"),
  content: z.string().describe("Full new file content"),
});
const Output = z.object({
  path: z.string(),
  operation: z.enum(["create", "modify"]),
  bytes: z.number(),
  preimageHash: z.string().optional(),
  postimageHash: z.string(),
  diff: z.string(),
});

export const writeTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "write",
    version: "1",
    description:
      "Create or overwrite a file with the given content. Prefer `edit` for targeted changes.",
    effects: ["write"],
    idempotency: "idempotent",
    parallelSafe: false,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 10_000, maximumMs: 15_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const abs = resolveInWorkspace(ctx.workspaceRoot, input.path);
    let prior: string | undefined;
    try {
      prior = await readFile(abs, "utf8");
    } catch (err) {
      // Only a genuinely-absent file is a "create". Any OTHER read error (permissions, a directory, …) means
      // the file may EXIST but we can't read it — mislabeling that as create would let `amb rewind` delete it.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      prior = undefined;
    }
    if (prior !== undefined) ctx.checkpoint?.(prior); // save the pre-image for `amb rewind`
    // Rewriting a CRLF file keeps it CRLF (the model writes `\n`) instead of flipping every line ending.
    const content = prior !== undefined ? matchLineEndings(input.content, prior) : input.content;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    const operation = prior === undefined ? "create" : "modify";
    return {
      path: input.path,
      operation,
      bytes: Buffer.byteLength(content, "utf8"),
      preimageHash: prior === undefined ? undefined : sha256(prior),
      postimageHash: sha256(content),
      diff: unifiedDiff(prior ?? "", content, input.path),
    };
  },
};
