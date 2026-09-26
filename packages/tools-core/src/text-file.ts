import { createReadStream } from "node:fs";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** The largest file the editing tools load whole — they hold it, its new text and a diff in memory at once. */
export const MAX_EDIT_BYTES = 64 * 1024 * 1024;

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** A regular file's size, or an error naming why it can't be read as one (a folder, a pipe, a device). */
export async function regularFileSize(abs: string, path: string): Promise<number> {
  const st = await stat(abs);
  if (!st.isFile()) throw new Error(`${path} isn't a regular file`);
  return st.size;
}

/** A file's text for editing, refused up front when it is too large to hold in memory. */
export async function readForEdit(abs: string, path: string): Promise<string> {
  const size = await regularFileSize(abs, path);
  if (size > MAX_EDIT_BYTES) {
    throw new Error(
      `${path} is ${mb(size)} — too large to edit here (the limit is ${mb(MAX_EDIT_BYTES)}); change it with bash instead`,
    );
  }
  return readFile(abs, "utf8");
}

/** The first `n` bytes of a file. */
export async function readHead(abs: string, n: number): Promise<Buffer> {
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Lines `start` to `start + count` (0-based) of a text file, read as a stream so the file is never held
 * whole: reading stops at the end of the window. Lines split the way `split(/\r?\n/)` would, and a line
 * longer than `lineCap` characters is cut. `more` says whether the file goes on past the window.
 */
export async function readLineWindow(
  abs: string,
  start: number,
  count: number,
  lineCap: number,
  signal?: AbortSignal,
): Promise<{ lines: string[]; more: boolean }> {
  const end = start + count;
  const lines: string[] = [];
  let index = 0; // the line being read
  let current = "";
  let cut = false;
  const append = (piece: string) => {
    if (index < start || index >= end || cut) return;
    const room = lineCap - current.length;
    if (piece.length > room) {
      current += piece.slice(0, room);
      cut = true;
    } else current += piece;
  };
  const finishLine = () => {
    if (index >= start && index < end) {
      const line = current.endsWith("\r") ? current.slice(0, -1) : current;
      lines.push(cut ? `${line} … (line cut at ${lineCap} characters)` : line);
    }
    index++;
    current = "";
    cut = false;
  };
  const stream = createReadStream(abs, signal ? { signal } : {});
  const decoder = new StringDecoder("utf8");
  try {
    for await (const chunk of stream) {
      const text = decoder.write(chunk as Buffer);
      let pos = 0;
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", pos)) {
        append(text.slice(pos, nl));
        finishLine();
        pos = nl + 1;
        if (index > end) return { lines, more: true }; // a line past the window exists
      }
      append(text.slice(pos));
    }
    append(decoder.end());
    finishLine(); // the text after the last newline is a line too (empty when the file ends with one)
    return { lines, more: index > end };
  } finally {
    stream.destroy();
  }
}

/** One file a tool is about to write: its new content and what it held before (undefined = it didn't exist). */
export interface PlannedWrite {
  abs: string;
  path: string;
  before: string | undefined;
  after: string;
}

/** Put a file back the way it was: remove one that didn't exist, rewrite one whose content changed. */
async function restore(f: PlannedWrite): Promise<void> {
  if (f.before === undefined) {
    await rm(f.abs, { force: true });
    return;
  }
  const now = await readFile(f.abs, "utf8").catch(() => undefined);
  if (now !== f.before) await writeFile(f.abs, f.before, "utf8");
}

/**
 * Write each file in order. If a write fails (disk full, a read-only file), every file written so far — and
 * the one that failed, which a failed write can leave cut short — goes back to its earlier content before
 * the error is reported, so a change across several files lands whole or not at all.
 */
export async function writeAllOrRestore(files: readonly PlannedWrite[]): Promise<void> {
  for (const [i, file] of files.entries()) {
    try {
      await writeFile(file.abs, file.after, "utf8");
    } catch (err) {
      const stuck: string[] = [];
      for (const f of files.slice(0, i + 1)) {
        await restore(f).catch(() => stuck.push(f.path));
      }
      const reason = (err as Error).message;
      throw new Error(
        stuck.length === 0
          ? `couldn't write ${file.path} (${reason}) — nothing was changed`
          : `couldn't write ${file.path} (${reason}), and couldn't put back ${stuck.join(", ")} — 'ambient rewind' has their earlier versions`,
      );
    }
  }
}
