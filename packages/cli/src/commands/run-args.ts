import { splitList } from "@amb/context";
import { parseRule } from "@amb/permissions";
import type { Mode } from "@amb/protocol";
import { AUTO_MODEL } from "@amb/reliability";
import type { EffortSetting } from "@amb/runtime";
import { type OutputFormat, parseOutputFormat } from "../agent/headless-output.js";
import type { AmbConfig } from "../config.js";
import { effortAliasNote, isParseError, parseEffort, parseMaxTurns } from "./args.js";

export interface RunArgs {
  task: string;
  model: string;
  mode: Mode;
  effort: EffortSetting;
  autoAllow: boolean;
  maxTurns: number;
  autoContinue: boolean;
  maxAutoContinues: number;
  jsonl: boolean;
  noMcp: boolean;
  images: string[];
  goal?: string;
  /** `-p`: print just the answer (or `--output-format` JSON) and never prompt. */
  print: boolean;
  outputFormat: OutputFormat;
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt?: string;
  /** `--continue` (latest here) or `--resume <id>`. */
  resume?: { from: string; here: boolean };
  mcpConfigs: string[];
  strictMcp: boolean;
  help: boolean;
  error?: string;
}

/** Run flags that take a value (the next word) — so a caller can tell a flag's value from the task. */
export const RUN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--model",
  "-m",
  "--image",
  "-i",
  "--goal",
  "-g",
  "--effort",
  "--max-turns",
  "--output-format",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--append-system-prompt",
  "--mcp-config",
  "--permission-mode",
  "-r",
  "--resume",
]);

/** Claude Code's `--permission-mode` names, and ours. */
const PERMISSION_MODES: Record<string, Mode> = {
  default: "ask",
  ask: "ask",
  plan: "plan",
  acceptEdits: "accept-edits",
  "accept-edits": "accept-edits",
  bypassPermissions: "bypass",
  bypass: "bypass",
};

export const USAGE = `usage: ambient run "<task>" [flags]   (or: ambient -p "<task>" [flags])

  -p, --print                    print only the answer; anything that would ask for approval is refused
  --output-format text|json|stream-json   json: one result object; stream-json: one line per step
  --allowedTools "<rules>"       e.g. "Bash(npm test:*) Edit" — run these without asking
  --disallowedTools "<rules>"    refuse these
  --append-system-prompt "<text>"   extra instructions for this run
  -c, --continue                 continue the latest conversation in this folder
  -r, --resume <id>              continue a specific session
  --mcp-config <file|json>       extra MCP servers (repeatable); --strict-mcp-config uses only these
  -m, --model <id>   -i, --image <path>   -g, --goal "<objective>"
  --plan | --accept-edits | --bypass (--yolo)
  --permission-mode default|plan|acceptEdits|bypassPermissions
  --yes                          auto-approve file edits (shell and network still ask)
  --effort auto|off|high|max   --max-turns <n>   --no-auto-continue   --no-mcp   --jsonl`;

export function parseRunArgs(args: string[], config: AmbConfig = {}): RunArgs {
  // Config sets the DEFAULTS; an explicit flag below always overrides.
  let model = config.model ?? AUTO_MODEL;
  let mode: Mode = config.mode ?? "ask";
  let effort: EffortSetting = config.effort ?? "auto";
  let autoAllow = false;
  let maxTurns = config.maxTurns ?? 120;
  let autoContinue = config.autoContinue ?? true;
  const maxAutoContinues = config.maxAutoContinues ?? 3;
  let jsonl = false;
  let noMcp = config.noMcp ?? false;
  let help = false;
  let error: string | undefined;
  const images: string[] = [];
  let goal: string | undefined;
  let print = false;
  let outputFormat: OutputFormat = "text";
  const allowedTools: string[] = [];
  const disallowedTools: string[] = [];
  let appendSystemPrompt: string | undefined;
  let resume: RunArgs["resume"];
  const mcpConfigs: string[] = [];
  let strictMcp = false;
  const parts: string[] = [];
  const value = (flag: string): string | undefined => {
    const v = args[++i];
    if (v === undefined) error = error ?? `${flag} needs a value`;
    return v;
  };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--print") print = true;
    else if (a === "--output-format") {
      const v = value(a);
      const f = parseOutputFormat(v);
      if (f) outputFormat = f;
      else if (v !== undefined)
        error = error ?? "--output-format must be text, json or stream-json";
    } else if (a === "--allowedTools" || a === "--allowed-tools") {
      allowedTools.push(...splitList(value(a) ?? ""));
    } else if (a === "--disallowedTools" || a === "--disallowed-tools") {
      disallowedTools.push(...splitList(value(a) ?? ""));
    } else if (a === "--append-system-prompt") {
      const v = value(a);
      if (v) appendSystemPrompt = v;
    } else if (a === "-c" || a === "--continue") resume = { from: "latest", here: true };
    else if (a === "-r" || a === "--resume") {
      const v = value(a);
      if (v) resume = { from: v, here: false };
    } else if (a === "--mcp-config") {
      const v = value(a);
      if (v) mcpConfigs.push(v);
    } else if (a === "--strict-mcp-config") strictMcp = true;
    else if (a === "--permission-mode") {
      const v = value(a);
      const m = v ? PERMISSION_MODES[v] : undefined;
      if (m) mode = m;
      else if (v !== undefined)
        error =
          error ?? "--permission-mode must be default, plan, acceptEdits or bypassPermissions";
    } else if (a === "--model" || a === "-m") model = args[++i] ?? model;
    else if (a === "--image" || a === "-i") {
      const p = args[++i];
      if (p) images.push(p);
    } else if (a === "--goal" || a === "-g") {
      const g = args[++i];
      if (g) goal = g.trim().slice(0, 280); // a north-star is tiny (matches the TUI cap)
    } else if (a === "--plan") mode = "plan";
    else if (a === "--accept-edits") mode = "accept-edits";
    else if (a === "--bypass" || a === "--yolo") mode = "bypass";
    else if (a === "--yes" || a === "-y") autoAllow = true;
    else if (a === "--jsonl") jsonl = true;
    else if (a === "--no-mcp") noMcp = true;
    else if (a === "--no-auto-continue") autoContinue = false;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--effort") {
      const raw = args[++i];
      const r = parseEffort(raw);
      if (isParseError(r)) error = r.error;
      else {
        effort = r.setting;
        if (r.alias) process.stderr.write(`${effortAliasNote(raw ?? "", r.setting)}\n`);
      }
    } else if (a === "--max-turns") {
      const r = parseMaxTurns(value(a));
      if (isParseError(r)) error = r.error;
      else maxTurns = r;
    } else if (a && /^--?[A-Za-z][\w-]*$/.test(a)) {
      // An unrecognized long flag is almost certainly a typo (`--modle`, `--bypas`) — reject it instead of
      // silently folding it into the TASK and running a billed job in the wrong mode.
      error = error ?? `unknown flag "${a}" — run \`ambient run --help\` for usage`;
    } else if (a) parts.push(a);
  }
  if (mode === "bypass") autoAllow = true;
  // A rule that doesn't parse must fail loudly: silently dropping `Bash(rm:*` from --disallowedTools would
  // leave the run less restricted than asked.
  const badRule = [...allowedTools, ...disallowedTools].find((r) => !parseRule(r) || !balanced(r));
  if (badRule !== undefined) error = error ?? `not a valid permission rule: "${badRule}"`;
  return {
    task: parts.join(" ").trim(),
    model,
    mode,
    effort,
    autoAllow,
    maxTurns,
    autoContinue,
    maxAutoContinues,
    jsonl,
    noMcp,
    images,
    ...(goal ? { goal } : {}),
    print,
    outputFormat,
    allowedTools,
    disallowedTools,
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    ...(resume ? { resume } : {}),
    mcpConfigs,
    strictMcp,
    help,
    error,
  };
}

/** Parentheses open and close in order (`Bash(rm:*` is not a rule). */
function balanced(rule: string): boolean {
  let depth = 0;
  for (const ch of rule) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}
