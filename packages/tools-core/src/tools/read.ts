import { readFile } from "node:fs/promises";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveReadable } from "../paths.js";

const Input = z.object({
  path: z.string().describe("File path relative to the workspace root"),
  offset: z.number().int().nonnegative().optional().describe("1-based line to start from"),
  limit: z.number().int().positive().optional().describe("Max lines to read"),
});
const Output = z.object({
  path: z.string(),
  lines: z.number(),
  content: z.string(),
  truncated: z.boolean(),
});

const MAX_LINES = 2000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|ico)$/i;
/** PDFs larger than this aren't opened (their text would never fit anyway). */
const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** A PDF's text, page by page (the PDF reader loads only when a PDF is actually read). */
async function pdfText(bytes: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((t, i) => `--- page ${i + 1} of ${pages.length} ---\n${t.trim()}`).join("\n\n");
}

/** Whether bytes look like binary data rather than text (a NUL byte early on). */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

export const readTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "read",
    version: "1",
    description:
      "Read a text file from the workspace (numbered lines). PDFs come back as their text, page by page; for an image, use view_image.",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 30_000, maximumMs: 60_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const abs = resolveReadable(ctx.workspaceRoot, input.path, ctx.readRoots?.list());
    if (ctx.readDenied?.(abs)) throw new Error(`${input.path}: reading it is denied by your rules`);
    if (IMAGE_EXT.test(abs)) {
      throw new Error(`${input.path} is an image — look at it with view_image`);
    }
    const bytes = await readFile(abs);
    let raw: string;
    if (/\.pdf$/i.test(abs) || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
      if (bytes.byteLength > MAX_PDF_BYTES)
        throw new Error(`${input.path} is too large a PDF to read`);
      try {
        raw = await pdfText(bytes);
      } catch (err) {
        throw new Error(`couldn't read the PDF ${input.path}: ${(err as Error).message}`);
      }
    } else if (looksBinary(bytes)) {
      throw new Error(`${input.path} is a binary file (${bytes.byteLength} bytes), not text`);
    } else {
      raw = bytes.toString("utf8");
    }
    const all = raw.split(/\r?\n/); // CRLF files show the same clean lines as LF ones
    const start = input.offset ? input.offset - 1 : 0;
    const end = Math.min(all.length, start + (input.limit ?? MAX_LINES));
    const slice = all.slice(start, end);
    const truncated = end < all.length || slice.length > MAX_LINES;
    const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    return { path: input.path, lines: slice.length, content: numbered, truncated };
  },
};
