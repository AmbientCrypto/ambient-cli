import type { Readable } from "node:stream";

/** Bound the piped read so a `cat huge.log | amb …` (or an accidental `amb < /dev/sda`) can't blow up memory
 *  or the model window. Logs/snippets fit comfortably; a larger pipe is truncated with a marker. */
export const MAX_STDIN_BYTES = 512 * 1024;

export interface PipedStdin {
  /** The captured text (already bounded). Empty when stdin is a TTY or nothing was piped. */
  text: string;
  /** True when the read hit MAX_STDIN_BYTES and the tail was dropped. */
  truncated: boolean;
}

/**
 * Read all of PIPED stdin so `cat err.log | amb "explain this"` folds the piped text into the task as
 * context. Returns "" immediately for an interactive terminal (isTTY) — it must NEVER block a human who is
 * about to type. The read is bounded to MAX_STDIN_BYTES; a longer stream is truncated (stream destroyed).
 *
 * `stdin` is injectable so the wiring is testable without a real pipe.
 */
export function readPipedStdin(
  stdin: Pick<Readable, "on" | "pause" | "destroy"> & { isTTY?: boolean } = process.stdin,
): Promise<PipedStdin> {
  // A TTY means a human is at the keyboard — reading would hang waiting for EOF they'll never send.
  if (stdin.isTTY) return Promise.resolve({ text: "", truncated: false });
  return new Promise<PipedStdin>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
    };
    stdin.on("data", (c: Buffer | string) => {
      if (total >= MAX_STDIN_BYTES) return; // already full; ignore any late chunk
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      const room = MAX_STDIN_BYTES - total;
      if (b.length > room) {
        chunks.push(b.subarray(0, room));
        total += room;
        truncated = true;
        // Stop pulling more bytes — we've captured the cap.
        stdin.pause();
        try {
          stdin.destroy();
        } catch {
          /* best-effort; `finish` still resolves below */
        }
        finish();
        return;
      }
      chunks.push(b);
      total += b.length;
    });
    stdin.on("end", finish);
    // A closed/errored pipe (EAGAIN, producer gone) means "no more input" — resolve with what we have, never
    // crash the run.
    stdin.on("error", finish);
    stdin.on("close", finish);
  });
}

/**
 * Fold piped stdin into an explicit task/prompt. With both present, the piped text is appended as a clearly
 * labelled context block (so the model sees "explain this" + the log). With only stdin, the pipe IS the task
 * (`echo "what is 2+2" | amb`). Pure — the effectful read lives in `readPipedStdin`.
 */
export function mergeStdin(task: string, piped: PipedStdin): string {
  const trimmed = piped.text.trim();
  if (!trimmed) return task;
  const block = piped.truncated ? `${trimmed}\n[stdin truncated]` : trimmed;
  if (!task) return block;
  return `${task}\n\n--- piped stdin ---\n${block}`;
}
