import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notebookEditTool } from "../src/tools/notebook-edit.js";

let ws: string;
const checkpoints: string[] = [];
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-nb-")));
  checkpoints.length = 0;
  writeFileSync(
    join(ws, "a.ipynb"),
    JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { kernelspec: { name: "python3" } },
        cells: [
          { cell_type: "markdown", id: "intro", metadata: {}, source: ["# Title\n"] },
          {
            cell_type: "code",
            id: "calc",
            metadata: {},
            source: ["x = 1\n", "print(x)"],
            outputs: [{ output_type: "stream", text: ["1\n"] }],
            execution_count: 3,
          },
        ],
      },
      null,
      1,
    ),
  );
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const ctx = (): ToolContext => ({
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
  checkpoint: (c) => void checkpoints.push(c),
});
const cells = () => JSON.parse(readFileSync(join(ws, "a.ipynb"), "utf8")).cells;

describe("notebook_edit", () => {
  it("replaces a code cell's source and clears its stale outputs", async () => {
    const r = await notebookEditTool.execute(
      { path: "a.ipynb", cell_id: "calc", new_source: "x = 2\nprint(x * 3)", edit_mode: "replace" },
      ctx(),
    );
    expect(r.cell).toBe(1);
    expect(cells()[1]).toMatchObject({
      id: "calc",
      source: ["x = 2\n", "print(x * 3)"],
      outputs: [],
      execution_count: null,
    });
    expect(checkpoints).toHaveLength(1); // the pre-image, for rewind
    expect(JSON.parse(readFileSync(join(ws, "a.ipynb"), "utf8")).metadata.kernelspec.name).toBe(
      "python3",
    );
  });

  it("inserts after a cell, or deletes one by position", async () => {
    await notebookEditTool.execute(
      {
        path: "a.ipynb",
        cell_id: "intro",
        new_source: "Some notes",
        cell_type: "markdown",
        edit_mode: "insert",
      },
      ctx(),
    );
    expect(cells().map((c: { cell_type: string }) => c.cell_type)).toEqual([
      "markdown",
      "markdown",
      "code",
    ]);
    expect(typeof cells()[1].id).toBe("string");
    await notebookEditTool.execute({ path: "a.ipynb", cell_index: 0, edit_mode: "delete" }, ctx());
    expect(cells()).toHaveLength(2);
  });

  it("explains a missing cell or a file that isn't a notebook", async () => {
    await expect(
      notebookEditTool.execute(
        { path: "a.ipynb", cell_id: "nope", new_source: "x", edit_mode: "replace" },
        ctx(),
      ),
    ).rejects.toThrow(/no cell with id nope/);
    await expect(
      notebookEditTool.execute({ path: "a.ipynb", cell_index: 9, edit_mode: "delete" }, ctx()),
    ).rejects.toThrow(/has 2 cells/);
    await expect(
      notebookEditTool.execute({ path: "a.py", cell_index: 0, edit_mode: "delete" }, ctx()),
    ).rejects.toThrow(/isn't a notebook/);
  });
});
