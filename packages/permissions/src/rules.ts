import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { PermissionDecision, PermissionInput } from "@amb/protocol";
import { hasUnmodeledExpansion } from "./read-only-command.js";
import { MAX_CMD_CHARS, baseName, parseShellCommands } from "./shell-tokens.js";

/**
 * Permission rules in Claude Code's syntax — `Bash(npm test:*)`, `Read(./secrets/**)`, `Edit(src/**)`,
 * `WebFetch(domain:example.com)`, `mcp__github`, or a bare tool name — layered over the mode ladder:
 *
 *   - a `deny` rule refuses the call in every mode (bypass included);
 *   - an `ask` rule makes the call ask even where it would run on its own (a denial stays a denial);
 *   - an `allow` rule answers a question the mode would have asked — it never lifts a denial (plan mode, the
 *     workspace boundary) and never overrides a deny or ask rule.
 */

export interface PermissionRule {
  /** The rule as written, for messages and listings. */
  text: string;
  /** Lower-cased tool name as written (`bash`, `read`, `mcp__github__search`). */
  tool: string;
  /** What's inside the parentheses, if anything. */
  specifier?: string;
}

export interface PermissionRules {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
}

export const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

/** `Tool` or `Tool(specifier)`; anything else is not a rule. */
export function parseRule(text: string): PermissionRule | null {
  const t = text.trim();
  const m = /^([A-Za-z_][\w.-]*)(?:\((.*)\))?$/s.exec(t);
  if (!m?.[1]) return null;
  const specifier = m[2]?.trim();
  return {
    text: t,
    tool: m[1].toLowerCase(),
    ...(specifier && specifier !== "*" ? { specifier } : {}),
  };
}

export function parseRules(texts: readonly unknown[] | undefined): PermissionRule[] {
  return (texts ?? [])
    .filter((t): t is string => typeof t === "string")
    .map(parseRule)
    .filter((r): r is PermissionRule => r !== null);
}

/** Which ambient tools a rule's tool name covers (Claude's names cover every tool of that kind). */
const TOOL_ALIASES: Record<string, readonly string[]> = {
  // Everything that runs a program: the shell, its background jobs, and the project's own checkers.
  bash: ["bash", "bash_output", "kill_shell", "diagnostics"],
  read: ["read", "grep", "glob", "list", "view_image"],
  grep: ["grep"],
  glob: ["glob"],
  ls: ["list"],
  list: ["list"],
  edit: ["edit", "apply_patch", "write", "notebook_edit"],
  multiedit: ["apply_patch"],
  apply_patch: ["apply_patch"],
  write: ["write"],
  notebookedit: ["notebook_edit"],
  webfetch: ["web_fetch"],
  web_fetch: ["web_fetch"],
  websearch: ["web_search"],
  web_search: ["web_search"],
  task: ["subagent"],
  agent: ["subagent"],
  subagent: ["subagent"],
};

function coversTool(rule: PermissionRule, toolName: string): boolean {
  const tool = toolName.toLowerCase();
  if (rule.tool.startsWith("mcp__")) {
    // `mcp__server` covers every tool of that server; `mcp__server__tool` just that one.
    return tool === rule.tool || tool.startsWith(`${rule.tool}__`);
  }
  return (TOOL_ALIASES[rule.tool] ?? [rule.tool]).includes(tool);
}

/** Tools whose rule specifier is a path. */
const FILE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "edit",
  "write",
  "apply_patch",
  "notebook_edit",
  "view_image",
]);

const isResourceTool = (name: string) =>
  name === "mcp_read_resource" || name === "mcp_list_resources";

/** A glob (`*` within a path segment, `**` across segments, `?` one character) as a RegExp. */
function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}

const toSlash = (p: string) => p.replace(/\\/g, "/");

/** Where a path pattern points: `//abs`, `~/in-home`, `/project-relative`, or relative to the project. */
function anchorPattern(pattern: string, root: string, home: string): string {
  const p = toSlash(pattern);
  const r = toSlash(root).replace(/\/+$/, "");
  if (p.startsWith("//")) return p.slice(1);
  if (/^[A-Za-z]:\//.test(p)) return p;
  if (p === "~" || p.startsWith("~/")) return `${toSlash(home).replace(/\/+$/, "")}${p.slice(1)}`;
  if (p.startsWith("/")) return `${r}${p}`;
  return `${r}/${p.replace(/^\.\//, "")}`;
}

/** The path as the filesystem resolves it (symlinks followed) — through the nearest existing folder when the
 *  path itself doesn't exist yet. */
function realPath(path: string): string {
  let head = path;
  let tail = "";
  for (let i = 0; i < 64; i++) {
    try {
      // `.native` also expands Windows 8.3 short names (C:\\PROGRA~1), so both spellings meet.
      const real = realpathSync.native(head);
      return tail ? `${real}${sepOf(path)}${tail}` : real;
    } catch {
      const cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
      if (cut <= 0) return path;
      tail = tail ? `${head.slice(cut + 1)}${sepOf(path)}${tail}` : head.slice(cut + 1);
      head = head.slice(0, cut);
    }
  }
  return path;
}
const sepOf = (p: string) => (/^[A-Za-z]:/.test(p) ? "\\" : "/");

/** macOS and Windows folders ignore letter case by default, so a rule must too (`.ENV` is `.env` there). */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** A path matches a pattern when it, or a folder it's inside, does (so `./secrets` covers what's in it) — by
 *  the path as written AND as the filesystem resolves it, so a symlink can't dodge a rule. */
function pathMatches(pattern: string, path: string, root: string, home: string): boolean {
  const insensitive = CASE_INSENSITIVE || /^[A-Za-z]:/.test(root);
  const variants = [
    anchorPattern(pattern, root, home),
    anchorPattern(pattern, realPath(root), realPath(home)),
  ];
  const res = [...new Set(variants)].map((v) => globToRegExp(v, insensitive));
  for (const candidate of new Set([path, realPath(path)])) {
    const norm = toSlash(
      /^[A-Za-z]:/.test(candidate) ? win32.normalize(candidate) : posix.normalize(candidate),
    );
    let p = norm.replace(/\/+$/, "");
    while (p) {
      if (res.some((re) => re.test(p))) return true;
      const cut = p.lastIndexOf("/");
      if (cut <= 0) break;
      p = p.slice(0, cut);
    }
  }
  return false;
}

/** Whether your deny rules keep a file from being read — checked by the tools that walk folders too, so a
 *  search over a parent folder can't return what `Read(./secrets/**)` denies. */
export function isReadDenied(
  rules: PermissionRules | undefined,
  path: string,
  workspaceRoot: string,
  home: string,
): boolean {
  return readDeniedMatcher(rules, workspaceRoot, home)(path);
}

/** `isReadDenied` for many paths (a folder walk): the rules are compiled once, not per file. */
export function readDeniedMatcher(
  rules: PermissionRules | undefined,
  workspaceRoot: string,
  home: string,
): (path: string) => boolean {
  const patterns = (rules?.deny ?? [])
    .filter((r) => r.specifier !== undefined && coversTool(r, "read"))
    .map((r) => r.specifier as string);
  if (patterns.length === 0) return () => false;
  const insensitive = CASE_INSENSITIVE || /^[A-Za-z]:/.test(workspaceRoot);
  const realRoot = realPath(workspaceRoot);
  const realHome = realPath(home);
  const res = patterns.flatMap((p) =>
    [...new Set([anchorPattern(p, workspaceRoot, home), anchorPattern(p, realRoot, realHome)])].map(
      (v) => globToRegExp(v, insensitive),
    ),
  );
  return (path) => matchesAny(res, path);
}

/** Whether a path, or a folder it's inside, matches — as written and as the filesystem resolves it. */
function matchesAny(res: readonly RegExp[], path: string): boolean {
  for (const candidate of new Set([path, realPath(path)])) {
    const norm = toSlash(
      /^[A-Za-z]:/.test(candidate) ? win32.normalize(candidate) : posix.normalize(candidate),
    );
    let p = norm.replace(/\/+$/, "");
    while (p) {
      if (res.some((re) => re.test(p))) return true;
      const cut = p.lastIndexOf("/");
      if (cut <= 0) break;
      p = p.slice(0, cut);
    }
  }
  return false;
}

/** Shell words that come before the command they introduce (`if rm x; then`, `{ rm x; }`, `! rm x`). */
const LEADING_KEYWORDS = new Set([
  "{",
  "(",
  "!",
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "time",
]);

/** Programs that run the rest of their arguments as a command (`env X=1 rm`, `nice -n 5 rm`, `sudo rm`). */
const WRAPPERS = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nice",
  "nohup",
  "time",
  "timeout",
  "sudo",
  "doas",
  "xargs",
  "stdbuf",
  "caffeinate",
  "setsid",
  "ionice",
  "unbuffer",
]);
/** Wrapper options that take a value (`nice -n 5`, `sudo -u root`, `timeout -s KILL`). */
const WRAPPER_VALUE_OPTS = new Set(["-n", "-u", "-g", "-s", "-k", "-C", "-I", "-L", "-P", "-a"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** The command a segment really runs: leading `VAR=value`s and wrappers dropped, the program by its name. */
function normalizeArgv(argv: readonly string[]): string[] {
  // Grouping brackets glued to a word (`(rm`, `x)`) belong to the shell, not the command.
  let a = argv.map((w) => w.replace(/^[({]+/, "").replace(/[)}]+$/, "")).filter((w) => w !== "");
  for (let guard = 0; guard < 12; guard++) {
    while (a[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a = a.slice(1);
    while (a[0] !== undefined && LEADING_KEYWORDS.has(a[0])) a = a.slice(1);
    const head = a[0];
    if (head === undefined) return [];
    // macOS and Windows find programs ignoring letter case (`RM` runs rm there).
    const name = CASE_INSENSITIVE ? baseName(head).toLowerCase() : baseName(head);
    // `command -v rm` only asks where rm is.
    if (name === "command" && /^-[vV]$/.test(a[1] ?? "")) return [name, ...a.slice(1)];
    if (!WRAPPERS.has(name) && !LEADING_KEYWORDS.has(name)) return [name, ...a.slice(1)];
    a = a.slice(1);
    // The wrapper's own options (and numeric durations/priorities) come before the command.
    while (a[0] !== undefined && (a[0].startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(a[0]))) {
      const opt = a[0];
      a = a.slice(1);
      if (opt === "--") break;
      if (WRAPPER_VALUE_OPTS.has(opt) && a[0] !== undefined) a = a.slice(1);
    }
  }
  return a;
}

/** The script of `sh -c '…'` (also `-lc`, `-ec`, `-c --`), if this runs one. */
function shellScript(argv: readonly string[]): string | undefined {
  if (!SHELLS.has(argv[0] ?? "")) return undefined;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i] as string;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) {
      const next = argv[i + 1] === "--" ? argv[i + 2] : argv[i + 1];
      return next;
    }
    if (!w.startsWith("-")) return undefined;
  }
  return undefined;
}

/** The text inside every `$(…)`, `<(…)`, `>(…)` and backtick substitution (nested ones included). */
function substitutions(command: string): string[] {
  const out: string[] = [];
  let single = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    // Nothing inside single quotes is substituted (`git commit -m 'drop the `rm` call'`).
    if (c === "'") {
      single = !single;
      continue;
    }
    if (single) continue;
    if ((c === "$" || c === "<" || c === ">") && command[i + 1] === "(") {
      let depth = 0;
      for (let j = i + 1; j < command.length; j++) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")" && --depth === 0) {
          out.push(command.slice(i + 2, j));
          break;
        }
      }
    } else if (c === "`") {
      const end = command.indexOf("`", i + 1);
      if (end > i) {
        out.push(command.slice(i + 1, end));
        i = end;
      }
    }
  }
  return out;
}

/**
 * Every simple command a shell line may run, each as its words joined by spaces — through wrappers
 * (`env`, `nice`, `sudo`, …), `sh -c "…"`, and command/process substitutions. Deny and ask rules check all of
 * them, so `/bin/rm`, `X=1 rm`, `bash -c 'rm …'` and `$(rm …)` are all still `rm`.
 */
export function shellSegments(command: string, depth = 0): string[] {
  const out: string[] = [];
  for (const c of parseShellCommands(command)) {
    const argv = normalizeArgv(c.argv);
    if (argv.length === 0) continue;
    out.push(argv.join(" ").trim());
    const script = shellScript(argv);
    if (script !== undefined && depth < 4) out.push(...shellSegments(script, depth + 1));
  }
  if (depth < 4)
    for (const inner of substitutions(command)) out.push(...shellSegments(inner, depth + 1));
  return out.filter(Boolean);
}

/** Programs that run a command given after one argument of their own (`flock <file> cmd`, `chrt <prio>
 *  cmd`, `taskset <mask> cmd`) or straight after their options (`watch cmd`, `parallel cmd`). */
const RUNS_AFTER_ONE_ARG = new Set(["flock", "chrt", "taskset"]);
const RUNS_REST = new Set(["watch", "parallel"]);
/** `find` options whose following words are a command it runs. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Programs whose `-c <script>` is a shell line they run. */
const RUNS_C_SCRIPT = new Set(["script", "su", "runuser", "flock"]);

/**
 * For deny and ask rules: commands another program runs that the wrapper list doesn't unwrap —
 * `find . -exec rm x ;`, `flock /tmp/l rm x`, `chrt 5 rm x`, `watch rm x`, `script -qc 'rm x'`.
 */
function runsInside(command: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  // Everything a word list could run: the words as a command, and a nested `sh -c` script.
  const add = (words: string[]) => {
    const argv = normalizeArgv(words);
    if (argv.length === 0) return;
    out.push(argv.join(" "));
    const script = shellScript(argv);
    if (script !== undefined) out.push(...shellSegments(script, depth + 1));
  };
  const script = (s: string) =>
    out.push(...shellSegments(s, depth + 1), ...runsInside(s, depth + 1));
  for (const c of parseShellCommands(command)) {
    const argv = normalizeArgv(c.argv);
    const name = argv[0] ?? "";
    const rest = argv.slice(1);
    if (name === "find") {
      rest.forEach((w, i) => {
        if (FIND_EXEC.has(w)) add(rest.slice(i + 1));
      });
    }
    // Which word starts the command depends on the program's own options (`watch -n 1 x`, `flock -w 5 f x`):
    // try every tail — for a deny or ask rule, matching too much is the safe side.
    if (RUNS_AFTER_ONE_ARG.has(name) || RUNS_REST.has(name)) {
      for (let i = 0; i < rest.length; i++) add(rest.slice(i));
    }
    if (RUNS_C_SCRIPT.has(name)) {
      rest.forEach((w, i) => {
        const next = rest[i + 1];
        if (/^-[A-Za-z]*c$/.test(w) && next !== undefined) script(next);
        const long = /^--command=(.*)$/s.exec(w)?.[1];
        if (long !== undefined) script(long);
        if (w === "--command" && next !== undefined) script(next);
      });
    }
  }
  return out;
}

/** Whether an allow rule can safely judge this command word by word: nothing the parser could read
 *  differently from bash (escapes, `$'…'`, substitutions, redirections, nested shells), and not so long the
 *  parser stops reading. */
function allowable(command: string): boolean {
  if (command.length > MAX_CMD_CHARS) return false;
  if (command.includes("\\") || command.includes("$'")) return false;
  if (hasUnmodeledExpansion(command) || hasRedirection(command)) return false;
  return !parseShellCommands(command).some((c) => {
    const argv = normalizeArgv(c.argv);
    return SHELLS.has(argv[0] ?? "") || argv.join(" ") !== c.argv.join(" ");
  });
}

/** Whether a command redirects input or output (`>`, `<`, `>>`, `2>`) outside quotes — an allow rule for the
 *  command itself must not also cover writing wherever the redirection points. */
export function hasRedirection(command: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"') i++;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === ">" || c === "<") return true;
  }
  return false;
}

/** `npm test:*` = the command or anything starting with it; otherwise `*` wildcards over the whole command. */
function commandMatches(rawSpec: string, rawSegment: string): boolean {
  const spec = CASE_INSENSITIVE ? rawSpec.toLowerCase() : rawSpec;
  const segment = CASE_INSENSITIVE ? rawSegment.toLowerCase() : rawSegment;
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2).trim();
    return segment === prefix || segment.startsWith(`${prefix} `);
  }
  if (!spec.includes("*")) return segment === spec.trim();
  const re = spec
    .trim()
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`, "s").test(segment);
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export interface RuleCall {
  toolName: string;
  args: Record<string, unknown>;
  /** Absolute paths the call touches. */
  resources: readonly string[];
  workspaceRoot: string;
  home: string;
}

/**
 * Whether a rule covers a call. `mode` decides how a compound shell line is judged: a deny or ask rule
 * covers it when ANY part matches; an allow rule only when EVERY part does (so `Bash(npm test:*)` never lets
 * `npm test && rm -rf ~` through) and nothing is hidden in a substitution or redirection.
 */
export function ruleCovers(rule: PermissionRule, call: RuleCall, mode: "any" | "all"): boolean {
  if (isResourceTool(call.toolName) && rule.tool.startsWith("mcp__")) {
    // Reading an MCP server's resources is that server's business: `mcp__github` covers them too.
    const server = typeof call.args.server === "string" ? call.args.server : undefined;
    return server === undefined ? mode === "any" : `mcp__${server}`.toLowerCase() === rule.tool;
  }
  if (!coversTool(rule, call.toolName)) return false;
  const spec = rule.specifier;
  if (spec === undefined) return true;
  const tool = call.toolName.toLowerCase();
  if (tool === "bash") {
    const command = typeof call.args.command === "string" ? call.args.command : "";
    if (mode === "all") {
      const parts = shellSegments(command);
      return parts.length > 0 && allowable(command) && parts.every((p) => commandMatches(spec, p));
    }
    // Too long to read in full: a deny or ask rule can't be sure it isn't there, so it counts as matched.
    if (command.length > MAX_CMD_CHARS) return true;
    return (
      commandMatches(spec, command.trim()) ||
      shellSegments(command).some((p) => commandMatches(spec, p)) ||
      runsInside(command).some((p) => commandMatches(spec, p))
    );
  }
  if (tool === "web_fetch") {
    const host = hostOf(call.args.url);
    const m = /^domain:(.+)$/i.exec(spec);
    if (!host || !m?.[1]) return false;
    const domain = m[1].trim().toLowerCase().replace(/^\*\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  }
  // An agent or skill rule names the preset or skill (`Task(reviewer)`, `Skill(deploy)`).
  if (tool === "subagent") {
    const spawn = Array.isArray(call.args.spawn) ? call.args.spawn : [];
    const names = spawn.flatMap((s) => {
      const o = s as { preset?: unknown; role?: unknown };
      return [o.preset, o.role].filter((v): v is string => typeof v === "string");
    });
    return mode === "all"
      ? names.length > 0 && names.every((n) => n === spec)
      : names.includes(spec);
  }
  if (tool === "skill") return call.args.name === spec;
  if (!FILE_TOOLS.has(tool)) return false;
  // File tools: the specifier is a path pattern checked against every path the call touches. A call whose
  // paths can't be told can't be shown to stay clear of a deny or ask rule, so those count it as matched.
  if (call.resources.length === 0) return mode === "any";
  const test = (p: string) => pathMatches(spec, p, call.workspaceRoot, call.home);
  return mode === "all" ? call.resources.every(test) : call.resources.some(test);
}

/** Apply the rules to the mode's decision. */
export function applyRules(
  base: PermissionDecision,
  rules: PermissionRules,
  input: PermissionInput,
  home: string,
): PermissionDecision {
  const call: RuleCall = {
    toolName: input.toolName,
    args: input.normalizedArgs,
    resources: input.resolvedResources,
    workspaceRoot: input.workspaceRoot,
    home,
  };
  const denied = rules.deny.find((r) => ruleCovers(r, call, "any"));
  if (denied) return { effect: "deny", reason: `your rule ${denied.text}` };
  const asked = rules.ask.find((r) => ruleCovers(r, call, "any"));
  if (asked) {
    return base.effect === "deny"
      ? base
      : { effect: "ask", reason: `your rule ${asked.text} asks first` };
  }
  if (base.effect === "ask") {
    const allowed = rules.allow.find((r) => ruleCovers(r, call, "all"));
    if (allowed) return { effect: "allow", reason: `allowed by your rule ${allowed.text}` };
  }
  return base;
}
