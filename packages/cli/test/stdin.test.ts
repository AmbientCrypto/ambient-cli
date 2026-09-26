import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_STDIN_BYTES, mergeStdin, readPipedStdin } from "../src/commands/stdin.js";

/** A Readable seeded with `data`, with an injectable isTTY flag. */
function pipe(data: string | Buffer, isTTY = false): Readable & { isTTY?: boolean } {
  const r = Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(data)]) as Readable & {
    isTTY?: boolean;
  };
  r.isTTY = isTTY;
  return r;
}

describe("readPipedStdin", () => {
  it("returns the piped text for a non-TTY stream", async () => {
    const res = await readPipedStdin(pipe("hello from a pipe"));
    expect(res).toEqual({ text: "hello from a pipe", truncated: false });
  });

  it("NEVER reads a TTY (a human is typing — reading would hang)", async () => {
    // isTTY=true short-circuits before any listener is attached, so even a stream with data yields "".
    const res = await readPipedStdin(pipe("would block", true));
    expect(res).toEqual({ text: "", truncated: false });
  });

  it("bounds the read to MAX_STDIN_BYTES and marks it truncated", async () => {
    const big = "x".repeat(MAX_STDIN_BYTES + 4096);
    const res = await readPipedStdin(pipe(big));
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.text)).toBe(MAX_STDIN_BYTES);
  });

  it("resolves to empty on an empty pipe", async () => {
    const res = await readPipedStdin(pipe(""));
    expect(res).toEqual({ text: "", truncated: false });
  });
});

describe("mergeStdin", () => {
  it("appends piped text as a labelled context block when a task is present", () => {
    const out = mergeStdin("explain this", { text: "TypeError: boom\n", truncated: false });
    expect(out).toBe("explain this\n\n--- piped stdin ---\nTypeError: boom");
  });

  it("uses the pipe AS the task when no task arg is given", () => {
    expect(mergeStdin("", { text: "what is 2+2", truncated: false })).toBe("what is 2+2");
  });

  it("leaves the task untouched when nothing was piped", () => {
    expect(mergeStdin("do the thing", { text: "   ", truncated: false })).toBe("do the thing");
  });

  it("marks a truncated pipe in the folded block", () => {
    expect(mergeStdin("", { text: "line1\nline2", truncated: true })).toBe(
      "line1\nline2\n[stdin truncated]",
    );
  });
});
