import { AUTO_MODEL } from "@amb/reliability";
import { type AmbConfig, grantsFromConfig, loadConfig, tuiAxesFromMode } from "../config.js";
import { runTui } from "../tui/run.js";
import type { AgentMode, Effort, Permission } from "../tui/state.js";
import { effortAliasNote, isParseError, parseEffort, parseMaxTurns } from "./args.js";

interface TuiArgs {
  model: string;
  agentMode: AgentMode;
  permission: Permission;
  effort: Effort;
  maxTurns: number;
  autoContinue: boolean;
  maxAutoContinues: number;
  checkUpdates: boolean;
  initialTask?: string;
  goal?: string;
  noMcp: boolean;
  error?: string;
}

export function parseArgs(args: string[], config: AmbConfig = {}): TuiArgs {
  // Config sets the DEFAULTS; a flag below overrides. `mode` maps onto the TUI's two axes (agentMode + permission).
  const axes = tuiAxesFromMode(config.mode ?? "ask");
  let model = config.model ?? AUTO_MODEL;
  let agentMode: AgentMode = axes.agentMode;
  let permission: Permission = axes.permission;
  let effort: Effort = config.effort ?? "auto";
  let maxTurns = config.maxTurns ?? 120;
  let autoContinue = config.autoContinue ?? true;
  const maxAutoContinues = config.maxAutoContinues ?? 3;
  const checkUpdates = config.checkUpdates ?? true;
  let noMcp = config.noMcp ?? false;
  let goal: string | undefined;
  let error: string | undefined;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model" || a === "-m") model = args[++i] ?? model;
    else if (a === "--goal" || a === "-g") {
      const g = args[++i];
      if (g) goal = g.trim().slice(0, 280);
    } else if (a === "--plan") agentMode = "plan";
    else if (a === "--build") agentMode = "build";
    else if (a === "--accept-edits") permission = "accept-edits";
    else if (a === "--bypass" || a === "--yolo") permission = "bypass";
    else if (a === "--no-mcp") noMcp = true;
    else if (a === "--no-auto-continue") autoContinue = false;
    else if (a === "--effort") {
      const raw = args[++i];
      const r = parseEffort(raw);
      if (isParseError(r)) error = r.error;
      else {
        effort = r.setting;
        if (r.alias) process.stderr.write(`${effortAliasNote(raw ?? "", r.setting)}\n`);
      }
    } else if (a === "--max-turns") {
      const r = parseMaxTurns(args[++i]);
      if (isParseError(r)) error = r.error;
      else maxTurns = r;
    } else if (a?.startsWith("--")) {
      // Reject a typo'd flag rather than folding it into the initial task (which auto-submits a billed run).
      error = error ?? `unknown flag "${a}"`;
    } else if (a) parts.push(a);
  }
  const initialTask = parts.join(" ").trim() || undefined;
  return {
    model,
    agentMode,
    permission,
    effort,
    maxTurns,
    autoContinue,
    maxAutoContinues,
    checkUpdates,
    initialTask,
    noMcp,
    ...(goal ? { goal } : {}),
    error,
  };
}

/** `ambient tui [--plan|--build|--accept-edits|--bypass|--effort|--model|--max-turns|--no-mcp] ["<task>"]` — the interactive TUI. */
export async function runTuiCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const {
    model,
    agentMode,
    permission,
    effort,
    maxTurns,
    autoContinue,
    maxAutoContinues,
    checkUpdates,
    initialTask,
    noMcp,
    goal,
    error,
  } = parseArgs(args, config);
  if (error) {
    process.stderr.write(`ambient: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  await runTui({
    agentMode,
    permission,
    effort,
    requestedModel: model,
    maxTurns,
    autoContinue,
    maxAutoContinues,
    checkUpdates,
    initialTask,
    noMcp,
    ...(goal ? { initialGoal: goal } : {}),
    // The persistent allowlist (config `allow`) seeds the session's grants so those tools don't re-prompt.
    initialGrants: grantsFromConfig(config),
    settingsConfig: config,
  });
}
