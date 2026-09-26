/**
 * A reader that stops early (`ambient -p … | head -1`) closes our stdout: finish quietly, like any CLI —
 * by cancelling the run (so hooks, MCP servers and any running command are cleaned up as on Ctrl-C) rather
 * than exiting on the spot. Later writes to the closed pipe are ignored.
 */
export function exitQuietlyOnClosedPipe(stream: NodeJS.WriteStream): void {
  let closed = false;
  stream.on("error", (err: NodeJS.ErrnoException) => {
    // The terminal itself went away (closed window, hang-up): nothing can be shown any more, and the hang-up
    // signal is already winding the run down — just stop writing, so cleanup can finish.
    if (err.code === "EIO" || err.code === "ENXIO" || err.code === "EBADF") return;
    if (err.code !== "EPIPE") throw err;
    if (closed) return;
    closed = true;
    // The reader has what it wanted: that's a normal end, not a failure or a cancel.
    process.once("exit", () => {
      process.exitCode = 0;
    });
    // Nothing is running that needs stopping (a quick command): just finish.
    if (process.listenerCount("SIGINT") === 0) process.exit(0);
    process.emit("SIGINT");
    // Cleanup is bounded: if something hangs, leave anyway.
    setTimeout(() => process.exit(process.exitCode ?? 0), 5_000).unref();
  });
}
