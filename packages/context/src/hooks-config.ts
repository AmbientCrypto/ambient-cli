import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTextCappedSafe } from "./fs-safe.js";
import { installedPlugins } from "./plugins.js";

/**
 * Hook configuration in Claude Code's format — `{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks":
 * [{"type": "command", "command": "…", "timeout": 60}]}]}}` — gathered from every place it can live. Where a
 * hook comes from decides whether it runs: ambient's own config always; a project's only once the user has
 * trusted exactly that configuration; the user's Claude Code hooks and plugin hooks only when opted in.
 */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "Notification",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookSource = "ambient" | "project" | "claude-user" | "plugin";

export interface HookCommand {
  event: HookEvent;
  /** Tool-name pattern for tool events (`Bash`, `Edit|Write`, `mcp__.*`); empty matches everything. */
  matcher: string;
  command: string;
  timeoutMs: number;
  source: HookSource;
  /** For plugin hooks: the plugin's folder (`${CLAUDE_PLUGIN_ROOT}` in the command). */
  pluginRoot?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

/** Read the `hooks` block of a settings object into commands. Unknown events and non-command hooks are skipped. */
export function parseHooks(
  settings: unknown,
  source: HookSource,
  pluginRoot?: string,
): HookCommand[] {
  const hooks = (settings as { hooks?: unknown } | undefined)?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: HookCommand[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const group = g as { matcher?: unknown; hooks?: unknown };
      const matcher = typeof group.matcher === "string" ? group.matcher : "";
      for (const h of Array.isArray(group.hooks) ? group.hooks : []) {
        const hook = h as { type?: unknown; command?: unknown; timeout?: unknown };
        if (hook.type !== "command" || typeof hook.command !== "string" || !hook.command.trim())
          continue;
        const seconds =
          typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout : undefined;
        out.push({
          event,
          matcher,
          command: hook.command,
          timeoutMs: seconds ? Math.min(MAX_TIMEOUT_MS, seconds * 1000) : DEFAULT_TIMEOUT_MS,
          source,
          ...(pluginRoot ? { pluginRoot } : {}),
        });
      }
    }
  }
  return out;
}

function readJsonFile(file: string, root: string): unknown {
  const text = readTextCappedSafe(file, { root });
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A stable fingerprint of a set of hooks — trust is granted to exactly this configuration. */
export function hooksFingerprint(hooks: readonly HookCommand[]): string {
  const canonical = hooks.map((h) => [h.event, h.matcher, h.command, h.timeoutMs]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export interface DiscoveredHooks {
  /** ambient's own hooks (from its config) — always run. */
  ambient: HookCommand[];
  /** The project's `.claude/settings.json` / `settings.local.json` hooks — run once trusted. */
  project: HookCommand[];
  /** The user's `~/.claude/settings.json` hooks — run when Claude hooks are turned on. */
  claudeUser: HookCommand[];
  /** Hooks from enabled Claude Code plugins (`hooks/hooks.json`) — run when Claude hooks are turned on. */
  plugins: HookCommand[];
}

export function discoverHooks(opts: {
  workspaceRoot: string;
  home?: string;
  /** The `hooks` block from ambient's config, if any. */
  ambientSettings?: unknown;
  /** Whether the project's own settings may turn plugins on or off (only once it's trusted). */
  projectPlugins?: boolean;
}): DiscoveredHooks {
  const home = opts.home ?? homedir();
  const projectDir = join(opts.workspaceRoot, ".claude");
  const project = [
    ...parseHooks(readJsonFile(join(projectDir, "settings.json"), projectDir), "project"),
    ...parseHooks(readJsonFile(join(projectDir, "settings.local.json"), projectDir), "project"),
  ];
  const userDir = join(home, ".claude");
  // The project folder IS the home folder when run from ~ — then its settings are the user's, not a project's.
  const sameAsUser = projectDir === userDir;
  return {
    ambient: parseHooks(opts.ambientSettings, "ambient"),
    project: sameAsUser ? [] : project,
    claudeUser: parseHooks(readJsonFile(join(userDir, "settings.json"), userDir), "claude-user"),
    plugins: installedPlugins(opts.workspaceRoot, home, {
      projectSettings: opts.projectPlugins === true,
    }).flatMap((p) =>
      parseHooks(readJsonFile(join(p.root, "hooks", "hooks.json"), p.root), "plugin", p.root),
    ),
  };
}

/** Allow / deny / ask rule lists as written in a settings file's `permissions` block. */
export interface RuleLists {
  allow: string[];
  deny: string[];
  ask: string[];
}

const EMPTY_RULES: RuleLists = { allow: [], deny: [], ask: [] };

/** Read the `permissions` block of a settings object. */
export function parseRuleLists(settings: unknown): RuleLists {
  const perms = (settings as { permissions?: unknown } | undefined)?.permissions;
  if (!perms || typeof perms !== "object") return EMPTY_RULES;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const p = perms as Record<string, unknown>;
  return { allow: list(p.allow), deny: list(p.deny), ask: list(p.ask) };
}

export interface DiscoveredRules {
  /** The project's `.claude/settings.json` + `settings.local.json`. */
  project: RuleLists;
  /** The user's `~/.claude/settings.json`. */
  claudeUser: RuleLists;
}

export function discoverRuleLists(opts: { workspaceRoot: string; home?: string }): DiscoveredRules {
  const home = opts.home ?? homedir();
  const projectDir = join(opts.workspaceRoot, ".claude");
  const userDir = join(home, ".claude");
  const merge = (a: RuleLists, b: RuleLists): RuleLists => ({
    allow: [...a.allow, ...b.allow],
    deny: [...a.deny, ...b.deny],
    ask: [...a.ask, ...b.ask],
  });
  const project = merge(
    parseRuleLists(readJsonFile(join(projectDir, "settings.json"), projectDir)),
    parseRuleLists(readJsonFile(join(projectDir, "settings.local.json"), projectDir)),
  );
  return {
    project: projectDir === userDir ? EMPTY_RULES : project,
    claudeUser: parseRuleLists(readJsonFile(join(userDir, "settings.json"), userDir)),
  };
}
