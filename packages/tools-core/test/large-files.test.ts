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
  rmSync(ws, { recursive: true, force: true, maxRetries: 5 });
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
    const samples = [
      "",
      "a",
      "a\n",
      "a\r\nb",
      "\n\n",
      "one\ntwo\r\nthree\n",
      "é漢\n字😀\r\n",
      "tail\r",
      "a\r\n\r",
      "\r\n",
    ];
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
    expect(got.cut).toBe(true);
    // A line exactly at the cap, ended by CRLF, isn't cut.
    writeFileSync(join(ws, "crlf.txt"), `${"b".repeat(100)}\r\nnext`);
    const exact = await readLineWindow(join(ws, "crlf.txt"), 0, 1, 100);
    expect(exact).toEqual({ lines: ["b".repeat(100)], more: true, cut: false });
  });

  it.runIf(posix)(
    "stops at the end of the window instead of scanning a huge next line",
    async () => {
      sparseFile(join(ws, "one.log"), "first\n", 64 * 1024 ** 3); // line 2 is 64 GB of zeros (sparse)
      const got = await readLineWindow(join(ws, "one.log"), 0, 1, 100);
      expect(got).toEqual({ lines: ["first"], more: true, cut: false });
    },
  );

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

describe("write when the file appears meanwhile", () => {
  it("never overwrites or removes a file it didn't create", async () => {
    const { writeAllOrRestore } = await import("../src/text-file.js");
    writeFileSync(join(ws, "theirs.txt"), "someone else's\n");
    await expect(
      writeAllOrRestore([
        { abs: join(ws, "theirs.txt"), path: "theirs.txt", before: undefined, after: "mine\n" },
      ]),
    ).rejects.toThrow(/something is already there.*nothing was changed/);
    expect(readFileSync(join(ws, "theirs.txt"), "utf8")).toBe("someone else's\n");
  });

  it("rolling back leaves alone a file something else changed meanwhile", async () => {
    const { restore } = await import("../src/text-file.js");
    const a = { abs: join(ws, "a.txt"), path: "a.txt", before: "old\n", after: "new\n" };
    writeFileSync(a.abs, "an editor's change\n");
    expect(await restore(a, false, undefined)).toBe(false);
    expect(readFileSync(a.abs, "utf8")).toBe("an editor's change\n");
    writeFileSync(a.abs, "new\n"); // still what the tool wrote → goes back
    expect(await restore(a, false, undefined)).toBe(true);
    expect(readFileSync(a.abs, "utf8")).toBe("old\n");
  });

  it("puts back a cut-short write, but not a file someone else rewrote, or replaced after creating", async () => {
    const { restore } = await import("../src/text-file.js");
    const { statSync, unlinkSync } = await import("node:fs");
    const a = { abs: join(ws, "a.txt"), path: "a.txt", before: "old\n", after: "brand new\n" };
    writeFileSync(a.abs, "brand"); // the failed write got this far
    expect(await restore(a, true, undefined)).toBe(true);
    expect(readFileSync(a.abs, "utf8")).toBe("old\n");
    writeFileSync(a.abs, "someone else's\n"); // not a prefix of what we wrote
    expect(await restore(a, true, undefined)).toBe(false);
    expect(readFileSync(a.abs, "utf8")).toBe("someone else's\n");

    const n = { abs: join(ws, "n.txt"), path: "n.txt", before: undefined, after: "x" };
    writeFileSync(n.abs, "x");
    const mine = statSync(n.abs);
    unlinkSync(n.abs);
    writeFileSync(n.abs, "theirs"); // replaced meanwhile: a different file at the same path
    const theirs = statSync(n.abs);
    const made = { dev: mine.dev, ino: mine.ino === theirs.ino ? mine.ino + 1 : mine.ino };
    expect(await restore(n, false, made)).toBe(false);
    expect(readFileSync(n.abs, "utf8")).toBe("theirs");
    // The file this call made, edited in place meanwhile: kept.
    expect(await restore(n, false, { dev: theirs.dev, ino: theirs.ino })).toBe(false);
    expect(readFileSync(n.abs, "utf8")).toBe("theirs");
    writeFileSync(n.abs, "x"); // still holding what this call wrote: removed
    expect(await restore(n, false, { dev: theirs.dev, ino: theirs.ino })).toBe(true);
    expect(() => statSync(n.abs)).toThrow();
  });
});

describe("glob stays inside the workspace", () => {
  it("refuses a pattern that climbs out", async () => {
    const { globTool } = await import("../src/tools/glob.js");
    await expect(globTool.execute({ pattern: "../**/*.ts", limit: 10 }, ctx())).rejects.toThrow(
      /`\.\.` isn't allowed/,
    );
  });
});

describe("grep without ripgrep", () => {
  const withoutRipgrep = async <T>(fn: () => Promise<T>): Promise<T> => {
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      return await fn();
    } finally {
      process.env.PATH = saved;
    }
  };

  it("searches a file named directly", async () => {
    const { grepTool } = await import("../src/tools/grep.js");
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "a.ts"), "one\nneedle here\n");
    const r = await withoutRipgrep(() =>
      grepTool.execute({ pattern: "needle", path: "src/a.ts", limit: 10 }, ctx()),
    );
    expect(r.matches).toEqual([{ file: "src/a.ts", line: 2, text: "needle here" }]);
  });

  it("stops a pattern that backtracks forever instead of freezing", async () => {
    const { grepTool } = await import("../src/tools/grep.js");
    writeFileSync(join(ws, "a.txt"), `${"a".repeat(40)}b\n`);
    const started = Date.now();
    await expect(
      withoutRipgrep(() => grepTool.execute({ pattern: "(a+)+$", path: ".", limit: 10 }, ctx())),
    ).rejects.toThrow(/takes too long to match/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});

describe("tools the user controls", () => {
  it("a stopped edit changes nothing", async () => {
    writeFileSync(join(ws, "a.txt"), "alpha\n");
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      editTool.execute(
        { path: "a.txt", oldString: "alpha", newString: "ALPHA", replaceAll: false },
        { ...ctx(), signal: stopped.signal },
      ),
    ).rejects.toThrow();
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("the model can't load a skill marked for the user only", async () => {
    const { skillTool } = await import("../src/tools/skill.js");
    mkdirSync(join(ws, ".claude", "skills", "release"), { recursive: true });
    writeFileSync(
      join(ws, ".claude", "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Ship it\ndisable-model-invocation: true\n---\nSECRET STEPS",
    );
    const r = await skillTool.execute({ name: "release" }, ctx());
    expect(r.found).toBe(false);
    expect(r.body).not.toContain("SECRET STEPS");
  });
});
