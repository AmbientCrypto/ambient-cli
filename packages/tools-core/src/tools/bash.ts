import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { BoundedCapture } from "../capture.js";
import { killProcessTree, machineShell, shellEnv, shellInvocation } from "../shell.js";

const SHELL = machineShell();

const Input = z.object({
  command: z.string().describe("Shell command to run in the workspace"),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run it in the background (a dev server, a watcher, a long build) and return right away; read its output with bash_output and stop it with kill_shell",
    ),
});
const Output = z.object({
  command: z.string(),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
  /** Set when the command was started in the background. */
  backgroundId: z.string().optional(),
});

const MAX_OUTPUT = 100_000; // chars per stream before truncation
/** After the shell exits, how long to wait for its output pipes to close before returning anyway. */
const DRAIN_AFTER_EXIT_MS = 2_000;
/** After a kill, how long to wait for output before returning. */
const DRAIN_AFTER_KILL_MS = 750;

export const bashTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "bash",
    version: "1",
    description:
      SHELL.kind === "pwsh" || SHELL.kind === "powershell"
        ? "Run a command in the workspace and capture stdout/stderr/exit code. This machine's shell is PowerShell — write PowerShell syntax (e.g. Get-ChildItem, Select-String, $env:VAR), not bash."
        : `Run a shell command in the workspace (${SHELL.label}) and capture stdout/stderr/exit code.`,
    effects: ["process", "read", "write"],
    idempotency: "non-idempotent",
    parallelSafe: false,
    resumability: "never-replay",
    timeoutPolicy: { idleMs: 120_000, maximumMs: 600_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  execute(input, ctx: ToolContext) {
    // A missing working directory makes spawn fail with a misleading "<shell> ENOENT"; say what's wrong.
    if (!existsSync(ctx.cwd)) {
      return Promise.reject(new Error(`the working directory doesn't exist: ${ctx.cwd}`));
    }
    if (input.background) {
      if (!ctx.backgroundJobs) {
        return Promise.reject(
          new Error("background commands aren't available here — run it normally"),
        );
      }
      try {
        const { id } = ctx.backgroundJobs.start(input.command, ctx.cwd);
        return Promise.resolve({
          command: input.command,
          exitCode: null,
          stdout: `Started in the background as ${id}. Read its output with bash_output({"id":"${id}"}); stop it with kill_shell({"id":"${id}"}).`,
          stderr: "",
          truncated: false,
          timedOut: false,
          backgroundId: id,
        });
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise((resolve, reject) => {
      // On POSIX `detached: true` makes the shell its OWN process-group leader so a timeout/abort can kill the
      // WHOLE tree (a dev server or `npm test` → node would otherwise keep the stdout pipe open and hang the
      // tool). On Windows `detached` would open a console window; the tree is killed with `taskkill /T`.
      const child = spawn(SHELL.path, shellInvocation(SHELL, input.command), {
        cwd: ctx.cwd,
        env: shellEnv(SHELL),
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const outCap = new BoundedCapture(MAX_OUTPUT);
      const errCap = new BoundedCapture(MAX_OUTPUT);
      let timedOut = false;

      let killed = false;
      let settled = false;
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      const killTree = () => {
        killed = true;
        // On Windows a pid is free for reuse once its process has exited, so an exited shell is never
        // targeted (that could kill an unrelated program). On POSIX the process group outlives its leader.
        if (typeof child.pid === "number" && !(process.platform === "win32" && exited())) {
          killProcessTree(child.pid);
        } else if (!exited()) {
          child.kill("SIGKILL");
        }
        // Don't wait on the pipes forever: something that escaped the kill may still hold them open.
        setTimeout(() => finish(child.exitCode), DRAIN_AFTER_KILL_MS);
      };
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({
          command: input.command,
          exitCode: code,
          stdout: cleanTerminalOutput(outCap.text()),
          stderr: cleanTerminalOutput(errCap.text()),
          truncated: outCap.truncated || errCap.truncated,
          timedOut,
        });
      };
      // A background job (`npm run dev &`) keeps the output pipes open after the shell exits, so `close` may
      // never come. Once the shell has exited, give output a moment to drain, then return what we have.
      child.on("exit", (code) => {
        setTimeout(() => finish(code), killed ? DRAIN_AFTER_KILL_MS : DRAIN_AFTER_EXIT_MS);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, input.timeoutMs);

      const onAbort = () => killTree();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d: Buffer) => {
        outCap.write(d.toString("utf8"));
      });
      child.stderr.on("data", (d: Buffer) => {
        errCap.write(d.toString("utf8"));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => finish(code));
    });
  },
};

/**
 * Make captured terminal output readable as text: CRLF → LF, a line redrawn with bare `\r` (progress bars)
 * keeps only its final state, and ANSI color/cursor sequences are removed.
 */
export function cleanTerminalOutput(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real terminal escape sequences
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => {
        const parts = line.split("\r");
        return parts[parts.length - 1] ?? "";
      })
      .join("\n")
  );
}
