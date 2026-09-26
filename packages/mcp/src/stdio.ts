import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "@amb/tools-core";
import crossSpawn from "cross-spawn";
import { LineFramer, type Transport } from "./jsonrpc.js";

/** Config for one stdio MCP server (the shape both Claude `.mcp.json` and Codex `[mcp_servers]` reduce to). */
export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Spawn an MCP server as a child process and wire its stdin/stdout as a newline-delimited JSON transport.
 * stderr is captured (bounded) for diagnostics but never parsed as protocol. The child is killed on close.
 */
/** Ambient's own secrets, which a server never gets unless its config passes them on purpose. */
const OWN_SECRETS = ["AMBIENT_API_KEY"];

/** The server's environment: ours (its PATH, HOME, tool settings) minus ambient's key, plus its own env. */
export function serverEnv(own: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of OWN_SECRETS) delete env[k];
  return { ...env, ...own };
}

export function spawnStdioTransport(cfg: StdioServerConfig): {
  transport: Transport;
  child: ChildProcess;
} {
  // cross-spawn resolves Windows launchers (`npx`, `uvx` are `.cmd` shims that plain spawn can't run) and
  // quotes their arguments safely; on POSIX it is a plain spawn. `detached: true` (POSIX only — on Windows it
  // opens a console window) makes the child its OWN process-group leader, so wrapper launchers put the REAL
  // server in the same group. On close we kill the whole tree — otherwise only the wrapper dies and the
  // orphaned server keeps our stdout pipe open, so `ambient run` HANGS after printing [complete].
  const child = crossSpawn(cfg.command, cfg.args ?? [], {
    cwd: cfg.cwd,
    env: serverEnv(cfg.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  let onMsg: (m: unknown) => void = () => {};
  let onClose: (err?: Error) => void = () => {};
  let closed = false;
  const framer = new LineFramer((m) => onMsg(m));

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => framer.push(d));
  // DRAIN stderr — a piped stream Node never reads fills the OS pipe (~64 KiB) and DEADLOCKS a child that
  // blocks on write(2) to fd 2 (MCP servers are told to log to stderr since stdout is the protocol channel).
  // An undrained chatty server would stall `initialize` to the timeout and read as "unavailable — skipped"
  // (a big contributor to slow startup). Keep only a bounded tail for diagnostics.
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });
  child.stderr?.on("error", () => {}); // never let an EPIPE on the diagnostic stream crash us
  void stderrTail; // captured for future diagnostics; the read itself is what prevents the deadlock
  const fireClose = (err?: Error) => {
    if (closed) return;
    closed = true;
    onClose(err);
  };
  child.on("exit", (code, signal) =>
    fireClose(new Error(`MCP server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`)),
  );
  child.on("error", (e) => fireClose(e));

  const transport: Transport = {
    send: (line) => {
      if (!closed) child.stdin?.write(line);
    },
    onMessage: (cb) => {
      onMsg = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    close: () => {
      closed = true;
      // Kill the whole process GROUP (negative pid) so wrapper-launched grandchildren die too — then destroy
      // our ends of the pipes so no stream ref keeps the event loop alive. Runs even if `exit` already fired,
      // to reap any group member that outlived the leader. Best-effort: ESRCH (already gone) is fine.
      // The whole tree (Windows: including Git Bash background jobs), so no orphan keeps our pipes open.
      const exited = child.exitCode !== null || child.signalCode !== null;
      // On Windows an exited process's pid can already belong to an unrelated program — never target it.
      if (typeof child.pid === "number" && !(process.platform === "win32" && exited)) {
        killProcessTree(child.pid);
      } else if (!exited) {
        child.kill("SIGKILL");
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    },
  };
  return { transport, child };
}
