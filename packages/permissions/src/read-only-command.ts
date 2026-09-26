import type { Effect } from "@amb/protocol";
import { baseName, parseShellCommands } from "./shell-tokens.js";

/**
 * A conservative classifier that recognizes a bash command as PURELY read-only, so the permission engine can
 * treat it as a `read` (auto-allowed, and permitted in plan mode) instead of a full `process` call that always
 * prompts. This NARROWS a security check, so the rules are deliberately strict — any doubt returns the
 * command's declared effects unchanged (i.e. it still prompts). Erring toward "prompt" is always safe here.
 *
 * A command downgrades to read-only ONLY when EVERY pipeline/sequence segment is a known read-only invocation
 * AND the raw command contains no redirection or command-substitution metacharacters.
 */

// Non-git commands that have NO file-writing form at all (output goes to stdout; redirection is blocked
// separately). Deliberately excludes anything with a write flag/positional (sed -i, awk, sort -o, uniq OUT,
// tee, find -delete/-exec, yq -i, dd, cp, mv, rm, …).
const READ_ONLY_CMDS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "stat",
  "file",
  "tree",
  "echo",
  "printf",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "which",
  "whoami",
  "id",
  "date",
  "uname",
  "hostname",
  "du",
  "df",
  "diff",
  "cmp",
]);

// git subcommands that are read-only in EVERY form (no mutating variant, no flag that writes a ref/file).
// Notably EXCLUDES the overloaded ones (branch/tag/stash/remote/config: each has a delete/create/set form),
// symbolic-ref (can rewrite HEAD), and ls-remote/fetch/pull (network). `--output` is rejected separately
// because it's a diff write-flag that applies to diff/show/log.
const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "describe",
  "blame",
  "shortlog",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-list",
  "merge-base",
  "whatchanged",
  "name-rev",
  "for-each-ref",
  "count-objects",
  "cherry",
  "grep",
]);

/** A short-option cluster (`-abc`) that includes `letter`. */
const shortFlag = (t: string, letter: string) =>
  /^-[A-Za-z]+$/.test(t) && t.slice(1).includes(letter);

/**
 * A long option that could mean `name` — the option itself, `--name=value`, or (for tools that accept
 * unambiguous abbreviations, like git and GNU coreutils) any shorter prefix of it.
 */
const longOption = (t: string, name: string, minLength = 1) => {
  if (!t.startsWith("--") || t.length < 3) return false;
  const opt = t.slice(2).split("=")[0] as string;
  return opt.length >= minLength && name.startsWith(opt);
};

/** Folders whose programs are the system's own, not something a project put there. */
const SYSTEM_BIN = new Set([
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/sbin",
  "/usr/sbin",
]);
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/** A plain command name (`ls`, `git`) or an absolute path to one (`/bin/ls`) — never an assignment. */
const COMMAND_WORD = /^(?:[A-Za-z0-9._+-]+|\/[A-Za-z0-9._+/-]+)$/;

/**
 * Options that turn an otherwise read-only command into one that runs a program or writes a file:
 * `rg --pre=<cmd>` / `--hostname-bin=<cmd>` run programs, `git grep -O<pager>` opens matches in an arbitrary
 * program, `tree -o <file>` and `file -C` write files, and `date`/`hostname` with arguments change the system.
 */
const UNSAFE_OPTION: Record<string, (argv: string[]) => boolean> = {
  rg: (argv) => argv.some((t) => t.startsWith("--pre") || t.startsWith("--hostname-bin")),
  // -o writes a file; -R with -H writes an HTML page into every directory and re-runs tree for each.
  tree: (argv) =>
    argv.some(
      (t) => shortFlag(t, "o") || shortFlag(t, "R") || shortFlag(t, "H") || longOption(t, "output"),
    ),
  file: (argv) => argv.some((t) => shortFlag(t, "C") || longOption(t, "compile")),
  // Only a display format (`date +%s`) or read-only flags; a bare operand or -s/--set changes the clock.
  date: (argv) =>
    argv
      .slice(1)
      .some(
        (t) =>
          shortFlag(t, "s") || longOption(t, "set") || (!t.startsWith("-") && !t.startsWith("+")),
      ),
  // Printing the name takes no operand; any operand or a file option sets it.
  hostname: (argv) =>
    argv.slice(1).some((t) => !t.startsWith("-") || shortFlag(t, "F") || longOption(t, "file")),
};
const UNSAFE_GIT_GREP = (argv: string[]) =>
  argv.some((t) => /^-[A-Za-z]*O/.test(t) || longOption(t, "open-files-in-pager"));

/**
 * Shell expansion the tokenizer doesn't model, outside single quotes: `$` (variables, `${X:=…}`, `$((…))`,
 * command substitution — also inside double quotes), globs `* ? [` (a file named `--pre=sh` in the repo turns
 * `rg foo *` into `rg --pre=sh …`), brace expansion `{`, a leading tilde `~` or comment `#`, and an `=` in a word that
 * isn't an option (an assignment). With none of these, the words bash runs are exactly the words checked.
 */
export function hasUnmodeledExpansion(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let wordStart = true;
  let wordIsOption = false;
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "$" || ch === "`") return true;
      continue;
    }
    if (/\s/.test(ch)) {
      wordStart = true;
      continue;
    }
    const atWordStart = wordStart;
    if (wordStart) {
      wordIsOption = ch === "-";
      wordStart = false;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // `~` and `#` only mean something at the start of a word (`HEAD~1`, `issue#4` are literal).
    if (atWordStart && (ch === "~" || ch === "#")) return true;
    if ("$*?[]{}`".includes(ch)) return true;
    if (ch === "=" && !wordIsOption) return true;
  }
  return quote !== undefined; // an unterminated quote is something the shell would read differently
}

/** Metacharacters that write files or execute arbitrary commands, and which the segment tokenizer does not
 *  split on — their mere presence in the raw command disqualifies the read-only downgrade. */
function hasDangerousMeta(command: string): boolean {
  return (
    command.includes(">") || // redirection (also covers >>)
    command.includes("<") || // redirection / here-strings
    command.includes("`") || // command substitution
    command.includes("$(") // command substitution
  );
}

/** True iff `command` is composed ENTIRELY of read-only invocations (see the rules above). */
export function isReadOnlyCommand(command: string): boolean {
  if (hasDangerousMeta(command)) return false;
  // Escapes are where a simple tokenizer and the real shell disagree about quoting (`"\"'"` ends differently
  // for each), so a command with any backslash is never downgraded — it just asks.
  if (command.includes("\\")) return false;
  if (hasUnmodeledExpansion(command)) return false;
  const segments = parseShellCommands(command);
  if (segments.length === 0) return false; // empty/whitespace — nothing to downgrade

  for (const seg of segments) {
    if (seg.quotedFirst) return false; // a fully-quoted first word is data, not a safe invocation
    // The first word must be the command itself: a plain name or an absolute path. `X=/ls rm -rf src` sets a
    // variable and runs `rm`; `GIT_EXTERNAL_DIFF=… git diff` runs a program of its choosing.
    if (!COMMAND_WORD.test(seg.argv[0] ?? "")) return false;
    // An absolute path counts only in a system program folder — a repo can ship its own `tools/cat`.
    if (seg.argv[0]?.startsWith("/") && !SYSTEM_BIN.has(dirOf(seg.argv[0]))) return false;
    const cmd = baseName(seg.argv[0] ?? "");
    if (!cmd) return false;
    // A diff-family write flag (`--output=<file>`) writes a file regardless of the subcommand — reject it.
    if (seg.argv.some((t) => t.startsWith("--output"))) return false;

    if (cmd === "git") {
      // Require the SAFE subcommand immediately after `git` (no global options like `-c alias=!cmd` before it).
      const sub = seg.argv[1];
      if (!sub || sub.startsWith("-") || !READ_ONLY_GIT.has(sub)) return false;
      if (sub === "grep" && UNSAFE_GIT_GREP(seg.argv)) return false;
      // External diff and text-conversion drivers are programs named in git config.
      if (seg.argv.some((t) => longOption(t, "ext-diff", 3) || longOption(t, "textconv", 3))) {
        return false;
      }
      continue;
    }
    if (!READ_ONLY_CMDS.has(cmd)) return false;
    if (UNSAFE_OPTION[cmd]?.(seg.argv)) return false;
  }
  return true;
}

/**
 * The effects to use for a bash call: read-only when `isReadOnlyCommand`, else the tool's declared effects.
 * Applies ONLY to the `bash` tool — every other tool keeps its manifest effects.
 */
export function refineBashEffects(toolName: string, args: unknown, declared: Effect[]): Effect[] {
  if (toolName !== "bash") return declared;
  const command = (args as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return declared;
  return isReadOnlyCommand(command) ? ["read"] : declared;
}
