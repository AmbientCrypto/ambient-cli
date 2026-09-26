import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";

const DEFAULT_LIMIT = 6_000;
const MAX_LIMIT = 10_000;
// The returned page's serialized JSON envelope must stay under the model-facing result byte cap
// (MAX_TOOL_RESULT_CHARS = 24000 UTF-8 bytes) or the runtime re-truncates + re-offloads it into a NESTED handle.
// A CHARACTER ceiling is not a reliable proxy for serialized BYTES: JSON escapes a control char
// to 6 bytes (backslash-u-XXXX) and a CJK char is 3 UTF-8 bytes — so we size the page by the ACTUAL serialized
// byte length, keeping a margin under the cap for the dynamic (often lower) per-result budget.
const PAGE_BYTE_BUDGET = 16_000;

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const byteLen = (s: string): number => new TextEncoder().encode(s).length;

const Input = z.object({
  handle: z
    .string()
    .min(1)
    .describe(
      "The artifact handle from a truncated tool output ([… call read_artifact({handle:…})])",
    ),
  offset: z.number().int().nonnegative().optional().describe("Start character offset (default 0)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional()
    .describe(
      `Max characters to return (default ${DEFAULT_LIMIT}; a page is further shrunk to stay under the result byte cap); page with offset`,
    ),
});
const Output = z.object({
  content: z.string(),
  offset: z.number(),
  returned: z.number(),
  total: z.number(),
  truncated: z.boolean(),
});

/**
 * The `read_artifact` tool — retrieve a slice of a large tool output that was OFFLOADED to the artifact store
 * when it didn't fit the window. Lets the model page through a big read/grep/bash result on demand
 * instead of losing it to truncation. Read-only (frictionless); a missing store/handle is an honest error.
 */
export const readArtifactTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "read_artifact",
    version: "1",
    description:
      "Retrieve more of a large tool output that was truncated and offloaded (using the handle shown in the '[output truncated …]' note). Pass offset/limit to page through it.",
    effects: ["read"],
    idempotency: "idempotent",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 5_000, maximumMs: 5_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const full = ctx.readArtifact?.(input.handle);
    if (full === undefined) {
      throw new Error(
        `artifact ${input.handle} not found (it may have expired, or this run has no artifact store)`,
      );
    }
    // Offsets are in UTF-16 code units (matching String.length/.slice). If the requested offset lands on the
    // LOW half of a REAL pair (the preceding unit is a HIGH surrogate), step back to include its HIGH half.
    // The `preceding-high` guard matters: a LONE low surrogate (malformed UTF-16) must NOT snap back, or paging
    // an all-low-surrogate string would move offset backward forever and never progress.
    let offset = Math.min(input.offset ?? 0, full.length);
    if (
      offset > 0 &&
      isLowSurrogate(full.charCodeAt(offset)) &&
      isHighSurrogate(full.charCodeAt(offset - 1))
    )
      offset -= 1;
    let end = Math.min(offset + (input.limit ?? DEFAULT_LIMIT), full.length);
    // Shrink the page until its SERIALIZED envelope fits the byte budget (JSON escaping ≫ char count for
    // control/CJK text) — measured against the real envelope so ANY content type is handled.
    const fits = (e: number): boolean =>
      byteLen(
        JSON.stringify(
          {
            content: full.slice(offset, e),
            offset,
            returned: e - offset,
            total: full.length,
            truncated: e < full.length,
          },
          null,
          2,
        ),
      ) <= PAGE_BYTE_BUDGET;
    while (end > offset + 1 && !fits(end))
      end = offset + Math.max(1, Math.floor((end - offset) * 0.8));
    // Never split a surrogate PAIR at the end: if the page would stop between a high+low pair, EXTEND to include
    // the low half. Extending (not trimming) guarantees the next offset always advances, so a
    // `limit:1` page on an emoji can't loop forever returning the same lone half.
    if (
      end < full.length &&
      isHighSurrogate(full.charCodeAt(end - 1)) &&
      isLowSurrogate(full.charCodeAt(end))
    )
      end += 1;
    const slice = full.slice(offset, end);
    return {
      content: slice,
      offset,
      returned: slice.length,
      total: full.length,
      truncated: end < full.length,
    };
  },
};
