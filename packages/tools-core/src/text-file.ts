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
 * longer than `lineCap` characters is cut (`cut` says one was). `more` says whether the file goes on past
 * the window.
 */
export async function readLineWindow(
  abs: string,
  start: number,
  count: number,
  lineCap: number,
  signal?: AbortSignal,
): Promise<{ lines: string[]; more: boolean; cut: boolean }> {
  const end = start + count;
  const lines: string[] = [];
  let index = 0; // the line being read
  let current = "";
  let dropped = false; // characters past the cap (plus room for a CRLF's \r) were left out of `current`
  let cut = false;
  const append = (piece: string) => {
    if (index < start || index >= end || dropped) return;
    const room = lineCap + 1 - current.length;
    if (piece.length > room) {
      current += piece.slice(0, room);
      dropped = true;
    } else current += piece;
  };
  const finishLine = (atNewline: boolean) => {
    if (index >= start && index < end) {
      // Only a \r right before a newline is a line ending; one at the very end of the file is text.
      let line = atNewline && !dropped && current.endsWith("\r") ? current.slice(0, -1) : current;
      if (dropped || line.length > lineCap) {
        line = `${line.slice(0, lineCap)} … (line cut at ${lineCap} characters)`;
        cut = true;
      }
      lines.push(line);
    }
    index++;
    current = "";
    dropped = false;
  };
  const stream = createReadStream(abs, signal ? { signal } : {});
  const decoder = new StringDecoder("utf8");
  try {
    for await (const chunk of stream) {
      const text = decoder.write(chunk as Buffer);
      let pos = 0;
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", pos)) {
        append(text.slice(pos, nl));
        finishLine(true);
        pos = nl + 1;
        // Past a newline there is always another line (empty at the end of the file), so the window is done.
        if (index >= end) return { lines, more: true, cut };
      }
      append(text.slice(pos));
    }
    append(decoder.end());
    finishLine(false); // the text after the last newline is a line too (empty when the file ends with one)
    return { lines, more: index > end, cut };
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

/** The identity of a file this call created, so a rollback removes only that file, never a replacement. */
interface Created {
  dev: number;
  ino: number;
}

/** Write one file. A new file is created exclusively, so one that appeared meanwhile is never overwritten;
 *  `state.created` records the file this call made (only it may be removed by a rollback). */
async function writeOne(
  f: PlannedWrite,
  state: { created?: Created },
  signal?: AbortSignal,
): Promise<void> {
  if (f.before !== undefined) {
    await writeFile(f.abs, f.after, { encoding: "utf8", ...(signal ? { signal } : {}) });
    return;
  }
  const fh = await open(f.abs, "wx");
  try {
    const st = await fh.stat();
    state.created = { dev: st.dev, ino: st.ino };
    await fh.writeFile(f.after, { encoding: "utf8", ...(signal ? { signal } : {}) });
  } finally {
    await fh.close();
  }
}

/**
 * Put one file back, touching it only while it still holds this call's own work: a file written in full
 * goes back only if it still has what was written; the one whose write failed only if it holds a cut-short
 * copy of it; a created file is removed only if it's still the file this call made. Anything else was
 * changed meanwhile by something else and is left alone (returns false).
 */
export async function restore(
  f: PlannedWrite,
  failed: boolean,
  created: Created | undefined,
): Promise<boolean> {
  if (f.before === undefined) {
    if (!created) return true; // never made it
    const st = await stat(f.abs).catch(() => undefined);
    if (!st) return true;
    if (st.dev !== created.dev || st.ino !== created.ino) return false;
    // The same file, but only while it holds this call's own content (edited in place meanwhile → keep).
    const content = await readFile(f.abs).catch(() => undefined);
    const written = Buffer.from(f.after, "utf8");
    const ours =
      content !== undefined &&
      (failed
        ? content.length <= written.length && written.subarray(0, content.length).equals(content)
        : content.equals(written));
    if (!ours) return false;
    await rm(f.abs, { force: true });
    return true;
  }
  const now = await readFile(f.abs).catch(() => undefined);
  if (now?.equals(Buffer.from(f.before, "utf8"))) return true;
  const written = Buffer.from(f.after, "utf8");
  const ours = failed
    ? now !== undefined &&
      now.length <= written.length &&
      written.subarray(0, now.length).equals(now)
    : now?.equals(written) === true;
  if (!ours) return false;
  await writeFile(f.abs, f.before, "utf8");
  return true;
}

/**
 * Write each file in order. If a write fails (disk full, a read-only file), every file written so far — and
 * the one that failed, which a failed write can leave cut short — goes back to its earlier content before
 * the error is reported, so a change across several files lands whole or not at all.
 */
export async function writeAllOrRestore(
  files: readonly PlannedWrite[],
  signal?: AbortSignal,
): Promise<void> {
  // A tool that was stopped (Ctrl-C, or it ran past its time limit and was already reported as failed)
  // must not change files afterwards.
  signal?.throwIfAborted();
  const created: Array<{ created?: Created }> = files.map(() => ({}));
  for (const [i, file] of files.entries()) {
    try {
      if (i > 0) signal?.throwIfAborted();
      await writeOne(file, created[i] as { created?: Created }, signal);
    } catch (err) {
      const unrestored: string[] = [];
      const changedMeanwhile: string[] = [];
      for (const [j, f] of files.slice(0, i + 1).entries()) {
        const ok = await restore(f, j === i, created[j]?.created).catch(() => {
          unrestored.push(f.path);
          return true;
        });
        if (!ok) changedMeanwhile.push(f.path);
      }
      const code = (err as NodeJS.ErrnoException).code;
      const reason =
        code === "EEXIST"
          ? "something is already there — created meanwhile, or a link"
          : (err as Error).message;
      const notes = [
        ...(unrestored.length > 0
          ? [`couldn't put back ${unrestored.join(", ")} — it may be left partly written`]
          : []),
        ...(changedMeanwhile.length > 0
          ? [`left ${changedMeanwhile.join(", ")} as it is — something else changed it meanwhile`]
          : []),
      ];
      throw new Error(
        notes.length === 0
          ? `couldn't write ${file.path} (${reason}) — nothing was changed`
          : `couldn't write ${file.path} (${reason}); ${notes.join("; ")}`,
      );
    }
  }
}
