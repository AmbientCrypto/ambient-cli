const READ_CHUNK_BYTES = 64 * 1024;
import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
/** Stream bounded UTF-8 records, keeping no whole-file string or split array. */
export function* journalLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      pending += bytes ? decoder.write(buffer.subarray(0, bytes)) : decoder.end();
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES)
          throw new Error("session record exceeds the 8 MiB recovery limit");
        if (line.trim()) yield line;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > MAX_RECORD_BYTES)
        throw new Error("session record exceeds the 8 MiB recovery limit");
      if (!bytes) break;
    }
    if (pending.trim()) yield pending;
  } finally {
    closeSync(fd);
  }
}
