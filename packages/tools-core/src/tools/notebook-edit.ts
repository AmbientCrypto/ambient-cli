import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { unifiedDiff } from "../diff.js";
import { sha256 } from "../hash.js";
import { resolveInWorkspace } from "../paths.js";

const Input = z.object({
  path: z.string().describe("The .ipynb notebook, relative to the workspace root"),
  cell_id: z
    .string()
    .optional()
    .describe("The cell to change (its id), or the one to insert after"),
  cell_index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Or the cell's position, 0 = first (used when the notebook's cells have no ids)"),
  new_source: z.string().optional().describe("The cell's new source (not needed to delete)"),
  cell_type: z
    .enum(["code", "markdown"])
    .optional()
    .describe("For a new cell, or to change a cell's type"),
  edit_mode: z.enum(["replace", "insert", "delete"]).default("replace"),
});
const Output = z.object({
  path: z.string(),
  operation: z.literal("modify"),
  cell: z.number(),
  edit: z.enum(["replace", "insert", "delete"]),
  preimageHash: z.string(),
  postimageHash: z.string(),
  diff: z.string(),
});

interface Cell {
  cell_type: string;
  id?: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

/** Notebook source is stored as lines that keep their `\n` (all but the last). */
function toSourceLines(text: string): string[] {
  const lines = text.split("\n");
  return lines
    .map((l, i) => (i < lines.length - 1 ? `${l}\n` : l))
    .filter((l, i, a) => !(l === "" && i === a.length - 1));
}

function newCell(type: "code" | "markdown", source: string, withId: boolean): Cell {
  const base = {
    ...(withId ? { id: randomUUID().slice(0, 8) } : {}),
    metadata: {},
    source: toSourceLines(source),
  };
  return type === "code"
    ? { cell_type: "code", ...base, outputs: [], execution_count: null }
    : { cell_type: "markdown", ...base };
}

/** Edit one cell of a Jupyter notebook: replace its source, insert a new cell, or delete it. */
export const notebookEditTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "notebook_edit",
    version: "1",
    description:
      "Edit a Jupyter notebook (.ipynb) cell: replace a cell's source, insert a new cell (after cell_id, or at cell_index), or delete a cell. Changing a code cell clears its old outputs.",
    effects: ["write"],
    idempotency: "non-idempotent",
    parallelSafe: false,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 10_000, maximumMs: 15_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    if (!input.path.toLowerCase().endsWith(".ipynb"))
      throw new Error(`${input.path} isn't a notebook (.ipynb)`);
    const abs = resolveInWorkspace(ctx.workspaceRoot, input.path);
    const prior = await readFile(abs, "utf8");
    let nb: { cells?: Cell[]; nbformat?: number; nbformat_minor?: number };
    try {
      nb = JSON.parse(prior);
    } catch {
      throw new Error(`${input.path} isn't valid notebook JSON`);
    }
    const cells = Array.isArray(nb.cells) ? [...nb.cells] : [];
    const withIds =
      cells.some((c) => typeof c.id === "string") ||
      (nb.nbformat ?? 4) * 100 + (nb.nbformat_minor ?? 0) >= 405;
    const byId = input.cell_id !== undefined ? cells.findIndex((c) => c.id === input.cell_id) : -1;
    if (input.cell_id !== undefined && byId < 0)
      throw new Error(`there is no cell with id ${input.cell_id}`);
    const at = byId >= 0 ? byId : input.cell_index;

    let index: number;
    if (input.edit_mode === "insert") {
      if (input.new_source === undefined) throw new Error("new_source is needed to insert a cell");
      // After the named cell, or at the given position (the end when neither is given).
      index = byId >= 0 ? byId + 1 : Math.min(input.cell_index ?? cells.length, cells.length);
      cells.splice(index, 0, newCell(input.cell_type ?? "code", input.new_source, withIds));
    } else {
      if (at === undefined || at < 0 || at >= cells.length) {
        throw new Error(
          `no such cell (the notebook has ${cells.length} cell${cells.length === 1 ? "" : "s"})`,
        );
      }
      index = at;
      if (input.edit_mode === "delete") cells.splice(index, 1);
      else {
        if (input.new_source === undefined)
          throw new Error("new_source is needed to replace a cell");
        const old = cells[index] as Cell;
        const type = input.cell_type ?? (old.cell_type === "markdown" ? "markdown" : "code");
        const { outputs: _outputs, execution_count: _count, ...rest } = old;
        const source = toSourceLines(input.new_source);
        // A code cell's old outputs no longer match its source; a markdown cell has none.
        const replaced: Cell =
          type === "code"
            ? { ...rest, cell_type: "code", source, outputs: [], execution_count: null }
            : { ...rest, cell_type: "markdown", source };
        cells[index] = replaced;
      }
    }
    ctx.checkpoint?.(prior); // the pre-image, for `amb rewind`
    // Jupyter writes one-space indentation and a trailing newline.
    const content = `${JSON.stringify({ ...nb, cells }, null, 1)}\n`;
    await writeFile(abs, content, "utf8");
    return {
      path: input.path,
      operation: "modify",
      cell: index,
      edit: input.edit_mode,
      preimageHash: sha256(prior),
      postimageHash: sha256(content),
      diff: unifiedDiff(prior, content, input.path),
    };
  },
};
