import { spawn } from "node:child_process";
import {
  constants,
  accessSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { readTextCappedSafe } from "@amb/context";
import type { VerifyOutcome, VerifyPort } from "@amb/runtime";
import {
  type ShellInfo,
  killProcessTree,
  machineShell,
  shellEnv,
  windowsPowerShellExe,
  windowsSystemExe,
} from "@amb/tools-core";

/**
 * The project's verification is an OPT-IN executable at `.ambient/verify` (a script the user provides — e.g.
 * `pnpm test && pnpm typecheck`). We never guess or auto-run `npm test`: if the file is absent, verification
 * is simply off (the runtime skips the gate — honest, never faked). The script runs after the model finishes
 * a file-mutating turn; exit 0 = verified, non-zero = re-ask the model with the captured output.
 */
const VERIFY_SCRIPT = ".ambient/verify";
const MAX_SUMMARY_CHARS = 6_000; // the FAILURE tail fed back to the model
const TIMEOUT_MS = 180_000;

export interface VerifyRunner {
  command: string;
  args: string[];
  /** Environment for the run, when it differs from ours (Git Bash needs its tool folders on PATH). */
  env?: Record<string, string | undefined>;
}

/**
 * How to run the project's verify script on this machine, or undefined when there is none we can run
 * (verification is then simply off — never a fake failure):
 *  - POSIX: `.ambient/verify`, executed directly when it's executable and either starts with `#!` (its
 *    interpreter is honored) or is a compiled program; otherwise via /bin/sh — the kernel won't exec a
 *    script without a `#!` line.
 *  - Windows: `.ambient/verify.ps1` (PowerShell), `.ambient/verify.cmd`/`.bat`, or a plain `.ambient/verify`
 *    through Git Bash when it's installed.
 */
export function verifyRunner(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
  isExecutable: (p: string) => boolean = executable,
  shell: () => ShellInfo = machineShell,
  runsDirectly: (p: string) => boolean = isDirectlyExecutable,
): VerifyRunner | undefined {
  const base = join(workspaceRoot, VERIFY_SCRIPT);
  if (platform === "win32") {
    if (exists(`${base}.ps1`)) {
      const ps = shell();
      const exe = ps.kind === "pwsh" || ps.kind === "powershell" ? ps.path : windowsPowerShellExe();
      return {
        command: exe,
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${base}.ps1`],
      };
    }
    for (const ext of [".cmd", ".bat"]) {
      if (exists(`${base}${ext}`)) {
        // Run it by its path RELATIVE to the workspace (the run's cwd): cmd.exe re-reads its command line, so
        // characters in the workspace path (`&`, `(`, `^`) must never reach it.
        return {
          command: process.env.ComSpec ?? windowsSystemExe("cmd.exe"),
          args: ["/d", "/c", `.ambient\\verify${ext}`],
        };
      }
    }
    const sh = shell();
    if (exists(base) && sh.kind === "bash") {
      return { command: sh.path, args: [base], env: shellEnv(sh) };
    }
    return undefined;
  }
  if (!exists(base)) return undefined;
  return isExecutable(base) && runsDirectly(base)
    ? { command: base, args: [] }
    : { command: "/bin/sh", args: [base] };
}

/** A script with a `#!` line or a compiled program (ELF / Mach-O) — what the kernel can exec directly. */
function isDirectlyExecutable(p: string): boolean {
  try {
    const fd = openSync(p, "r");
    try {
      const head = Buffer.alloc(4);
      const n = readSync(fd, head, 0, 4, 0);
      if (n >= 2 && head[0] === 0x23 && head[1] === 0x21) return true; // #!
      if (n < 4) return false;
      const magic = head.readUInt32BE(0);
      return (
        magic === 0x7f454c46 || // ELF
        magic === 0xfeedface ||
        magic === 0xfeedfacf ||
        magic === 0xcefaedfe ||
        magic === 0xcffaedfe ||
        magic === 0xcafebabe // Mach-O (thin / universal)
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The project's verify scripts that exist, with their contents — what trusting the project covers. Read
 *  size-capped and never through a link (a repository could point one at a device or a huge file). */
export function verifyScripts(workspaceRoot: string): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  for (const ext of VERIFY_EXTS) {
    const file = `${VERIFY_SCRIPT}${ext}`;
    const path = join(workspaceRoot, file);
    if (!existsLink(path)) continue;
    const content = isRegularFile(path) ? readTextCappedSafe(path, { root: workspaceRoot }) : null;
    out.push({ file, content: content ?? "(not a readable regular file — it won't run)" });
  }
  return out;
}

const VERIFY_EXTS = ["", ".ps1", ".cmd", ".bat"];

function existsLink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isRegularFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Runs the project's verify script after the agent changes files — only while the project is trusted: the
 * script comes with the repository, so a freshly cloned one can't run code before you've reviewed it. Trust
 * is checked again before every run (it covers the script's exact contents).
 */
export function makeVerifyPort(
  workspaceRoot: string,
  trusted: () => boolean,
): VerifyPort | undefined {
  const runner = verifyRunner(workspaceRoot);
  if (!runner || !trusted()) return undefined;
  // Only a real file runs — never a link or a device a repository put in its place.
  const scripts = VERIFY_EXTS.map((e) => join(workspaceRoot, `${VERIFY_SCRIPT}${e}`));
  if (scripts.some((p) => existsLink(p) && !isRegularFile(p))) return undefined;
  return async (signal) => (trusted() ? runVerifyScript(runner, workspaceRoot, signal) : null);
}

function runVerifyScript(
  runner: VerifyRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<VerifyOutcome> {
  return new Promise((resolve) => {
    let out = "";
    const append = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      // Keep only the TAIL — verification failures print at the end, and this bounds memory.
      if (out.length > MAX_SUMMARY_CHARS * 2) out = out.slice(-MAX_SUMMARY_CHARS * 2);
    };
    // On POSIX `detached` puts the script in its OWN process group so we can kill the WHOLE tree (its children
    // too) on timeout or Ctrl-C — a plain child.kill would orphan grandchildren (e.g. `pnpm test`'s workers).
    // Windows kills the tree with taskkill instead (detached there would open a console window).
    const child = spawn(runner.command, runner.args, {
      cwd,
      ...(runner.env ? { env: runner.env } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const killTree = () => {
      if (child.pid !== undefined) killProcessTree(child.pid);
    };
    let reason: "timeout" | "cancelled" | undefined;
    const timer = setTimeout(() => {
      reason = "timeout";
      killTree();
    }, TIMEOUT_MS);
    const onAbort = () => {
      reason = "cancelled";
      killTree();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, summary: `could not run ${VERIFY_SCRIPT}: ${e.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (reason === "timeout") {
        resolve({
          ok: false,
          summary: `${VERIFY_SCRIPT} timed out after ${TIMEOUT_MS / 1000}s\n${tail(out)}`,
        });
      } else if (reason === "cancelled") {
        resolve({ ok: false, summary: "verification cancelled" });
      } else {
        resolve({ ok: code === 0, summary: code === 0 ? "" : tail(out) });
      }
    });
  });
}

function tail(s: string): string {
  return s.length > MAX_SUMMARY_CHARS ? `…${s.slice(-MAX_SUMMARY_CHARS)}` : s;
}
