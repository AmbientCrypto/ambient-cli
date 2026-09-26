import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_EDIT_BYTES, readLineWindow } from "../src/text-file.js";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { editTool } from "../src/tools/edit.js";
import { readTool } from "../src/tools/read.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-large-")));
});
afterEach(() => {
  // A read-only file inside can block removal on Windows.
  try {
    chmodSync(join(ws, "b.txt"), 0o644);
  } catch {}
  rmSync(ws, { recursive: true, force: true });
});
const ctx = (): ToolContext => ({
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
});

/** A file `size` bytes long that holds `text` and then (sparse, taking no disk) zeros. */
function sparseFile(path: string, text: string, size: number): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, text);
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

const posix = process.platform !== "win32";
const root = typeof process.getuid === "function" && process.getuid() === 0;

describe("reading large files", () => {
  it.runIf(posix)("reads the first lines of a 3 GB file without loading it", async () => {
    // Enough text that the start doesn't look binary; then gigabytes a whole read couldn't hold.
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} of the log`).join("\n");
    sparseFile(join(ws, "huge.log"), `${text}\n`, 3 * 1024 ** 3);
    const r = await readTool.execute({ path: "huge.log", offset: 5, limit: 3 }, ctx());
    expect(r.content).toBe("5\tline 5 of the log\n6\tline 6 of the log\n7\tline 7 of the log");
    expect(r.truncated).toBe(true);
  });

  it("streams a file over the whole-read size with the same lines a small file gets", async () => {
    const line = "x".repeat(99);
    writeFileSync(join(ws, "big.txt"), `${line}\r\n`.repeat(180_000)); // ~18 MB, CRLF
    const r = await readTool.execute({ path: "big.txt", offset: 179_999, limit: 5 }, ctx());
    expect(r.content).toBe(`179999\t${line}\n180000\t${line}\n180001\t`);
    expect(r.truncated).toBe(false);
  });

  it("refuses a folder or a pipe instead of reading it", async () => {
    mkdirSync(join(ws, "dir"));
    await expect(readTool.execute({ path: "dir" }, ctx())).rejects.toThrow(/isn't a regular file/);
    if (posix) {
      execFileSync("mkfifo", [join(ws, "pipe")]);
      await expect(readTool.execute({ path: "pipe" }, ctx())).rejects.toThrow(
        /isn't a regular file/,
      );
    }
  });

  it("splits lines exactly like split(/\\r?\\n/), for any window", async () => {
    const samples = ["", "a", "a\n", "a\r\nb", "\n\n", "one\ntwo\r\nthree\n", "é漢\n字😀\r\n"];
    for (const text of samples) {
      writeFileSync(join(ws, "s.txt"), text);
      const all = text.split(/\r?\n/);
      for (const [start, count] of [
        [0, 1],
        [0, 10],
        [1, 1],
        [2, 5],
        [9, 2],
      ] as const) {
        const got = await readLineWindow(join(ws, "s.txt"), start, count, 1000);
        expect(got.lines).toEqual(all.slice(start, start + count));
        expect(got.more).toBe(start + count < all.length);
      }
    }
  });

  it("cuts one enormous line instead of holding all of it", async () => {
    writeFileSync(join(ws, "min.js"), `${"a".repeat(50_000)}\nnext`);
    const got = await readLineWindow(join(ws, "min.js"), 0, 2, 100);
    expect(got.lines[0]).toBe(`${"a".repeat(100)} … (line cut at 100 characters)`);
    expect(got.lines[1]).toBe("next");
  });

  it.runIf(posix)("won't load a file too large to edit", async () => {
    sparseFile(join(ws, "dump.sql"), "x", MAX_EDIT_BYTES + 1);
    await expect(
      editTool.execute(
        { path: "dump.sql", oldString: "x", newString: "y", replaceAll: false },
        ctx(),
      ),
    ).rejects.toThrow(/too large to edit here/);
  });
});

describe("apply_patch when a write fails", () => {
  it.skipIf(root)("puts back the files it already wrote", async () => {
    writeFileSync(join(ws, "a.txt"), "alpha\n");
    writeFileSync(join(ws, "b.txt"), "beta\n");
    chmodSync(join(ws, "b.txt"), 0o444); // readable, so the patch validates; the write then fails
    await expect(
      applyPatchTool.execute(
        {
          edits: [
            { path: "a.txt", oldString: "alpha", newString: "ALPHA", replaceAll: false },
            { path: "b.txt", oldString: "beta", newString: "BETA", replaceAll: false },
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow(/couldn't write b\.txt .*nothing was changed/);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("beta\n");
  });
});
