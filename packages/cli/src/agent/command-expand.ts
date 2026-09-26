import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { type SlashCommand, expandCommand, importRefs, readTextCappedSafe } from "@amb/context";
import { type PermissionRules, isReadDenied, parseRules, ruleCovers } from "@amb/permissions";
import { machineShell, shellEnv, shellInvocation } from "@amb/tools-core";

/**
 * Turn a custom slash command into the task it stands for: `$ARGUMENTS`/`$1…` are filled in, `@path`
 * references to files in the project are attached, and `` !`cmd` `` lines run — but only when the command's
 * own `allowed-tools` allows that exact shell command (and no deny rule of yours refuses it), the way Claude
 * Code gates them. Anything not allowed stays as written, with a note saying why it didn't run.
 */

const SHELL_TIMEOUT_MS = 30_000;
const MAX_SHELL_OUTPUT = 20_000;
const MAX_FILE_CHARS = 20_000;
const MAX_FILES = 10;

export interface ExpandOptions {
  workspaceRoot: string;
  home: string;
  /** The session's rules: a deny rule stops a `!` command even when the command file allows it. */
  rules?: PermissionRules;
  /** Whether this project's own settings are trusted — a project command's shell lines only run then. */
  projectTrusted?: boolean;
  /** Runs one shell command in the workspace; injectable for tests. */
  runShell?: (command: string, cwd: string) => string;
}

function defaultRunShell(command: string, cwd: string): string {
  const shell = machineShell();
  try {
    return execFileSync(shell.path, shellInvocation(shell, command), {
      cwd,
      env: shellEnv(shell),
      encoding: "utf8",
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || `(failed: ${err.message})`;
  }
}

export function expandSlashCommand(
  command: SlashCommand,
  args: string[],
  opts: ExpandOptions,
): string {
  const allowed = parseRules(command.allowedTools).filter((r) => r.tool === "bash");
  const run = opts.runShell ?? defaultRunShell;
  const call = (cmd: string) => ({
    toolName: "bash",
    args: { command: cmd },
    resources: [],
    workspaceRoot: opts.workspaceRoot,
    home: opts.home,
  });
  const runLine = (whole: string, cmd: string): string => {
    // A project's own command arrives with a clone: its shell lines wait until the project is trusted.
    if (command.source === "project" && opts.projectTrusted !== true) {
      return `${whole} (not run: this project's commands run shell lines once you trust it — /trust)`;
    }
    const denied = opts.rules?.deny.some((r) => ruleCovers(r, call(cmd), "any"));
    const permitted = !denied && allowed.some((r) => ruleCovers(r, call(cmd), "all"));
    if (!permitted) {
      return `${whole} (not run: ${denied ? "one of your deny rules refuses it" : "the command's allowed-tools doesn't include it"})`;
    }
    const out = run(cmd, opts.workspaceRoot).trim();
    return out.length > MAX_SHELL_OUTPUT ? `${out.slice(0, MAX_SHELL_OUTPUT)}…` : out;
  };
  // Shell lines are found in the command file as written — arguments are filled in around and inside them,
  // but text that only becomes `!`…`` after filling in (`!$ARGUMENTS`…``) is never run, so what /trust
  // reviewed is exactly what can run.
  const parts: string[] = [];
  let last = 0;
  for (const m of command.body.matchAll(/!`([^`\n]+)`/g)) {
    const at = m.index ?? 0;
    parts.push(expandCommand(command.body.slice(last, at), args));
    const cmd = expandCommand(m[1] as string, args);
    parts.push(runLine(`!\`${cmd}\``, cmd));
    last = at + m[0].length;
  }
  parts.push(expandCommand(command.body.slice(last), args));
  let text = parts.join("");
  const attached: string[] = [];
  for (const ref of importRefs(text).slice(0, MAX_FILES)) {
    const path = join(opts.workspaceRoot, ref.replace(/^\.\//, ""));
    if (isReadDenied(opts.rules, path, opts.workspaceRoot, opts.home)) continue;
    const content = readTextCappedSafe(path, { root: opts.workspaceRoot })?.trim();
    if (!content) continue;
    const shown =
      content.length > MAX_FILE_CHARS
        ? `${content.slice(0, MAX_FILE_CHARS)}\n…(truncated)`
        : content;
    attached.push(`## @${ref}\n\`\`\`\n${shown}\n\`\`\``);
  }
  if (attached.length > 0) text = `${text}\n\n${attached.join("\n\n")}`;
  return text;
}
