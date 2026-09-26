import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type HookCommand,
  type McpServerSpec,
  type RuleLists,
  discoverHooks,
  discoverRuleLists,
  hooksFingerprint,
  loadMcpConfig,
  projectEnabledPlugins,
  projectShellCommands,
} from "@amb/context";
import { type PermissionRules, parseRules } from "@amb/permissions";
import type { HooksPort } from "@amb/runtime";
import { hooksPort } from "./hooks.js";
import { verifyScripts } from "./verify-port.js";

/**
 * What a workspace's settings files ask for — hooks and permission rules — and whether each part applies.
 * Anything that only RESTRICTS (deny and ask rules) applies from every source. Anything that runs commands
 * or loosens approval does not apply from a project's own files (which arrive with a clone) until the user
 * trusts exactly that configuration, nor from ~/.claude and plugins (written for Claude Code) until the user
 * opts in with `claudeSettings`.
 */

export interface SettingsConfig {
  hooks?: unknown;
  /** Tool names that run without asking (ambient's original allow list). */
  allow?: string[];
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  claudeSettings?: boolean;
}

/** Where trusted project settings are remembered, by workspace. */
export function trustFilePath(configFolder: string): string {
  return join(configFolder, "trusted-projects.json");
}

function readTrust(file: string): Record<string, string> {
  try {
    if (!existsSync(file)) return {};
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    // Only workspace → fingerprint strings count; anything else in a hand-edited file is ignored.
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** What identifies a project MCP server for trust: its entry exactly as written — command, arguments, URL,
 *  and every environment and header template — so any change to it needs trusting again. */
function mcpIdentity(s: McpServerSpec): unknown[] {
  return [s.name, s.raw ?? [s.transport, s.command ?? "", s.args ?? [], s.url ?? ""]];
}

/** The environment variables a remote MCP entry puts into what it sends: `${VAR}` in its URL or headers,
 *  `bearer_token_env_var`, and `env_http_headers` values. Said plainly on the trust screen. */
export function sentVariables(m: McpServerSpec): string[] {
  const raw = (m.raw ?? {}) as Record<string, unknown>;
  const names = new Set<string>();
  for (const x of JSON.stringify(raw).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
    if (x[1]) names.add(x[1]);
  }
  if (typeof raw.bearer_token_env_var === "string") names.add(raw.bearer_token_env_var);
  const envHeaders = raw.env_http_headers;
  if (envHeaders && typeof envHeaders === "object") {
    for (const v of Object.values(envHeaders)) if (typeof v === "string") names.add(v);
  }
  return [...names];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Text from a project file, shown for review: control characters (which could hide or rewrite what's on
 *  screen) made visible instead of interpreted. */
export function visible(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Control characters, and the invisible ones that reorder or hide text (bidi overrides, zero-width).
    const control =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    out += control ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
  }
  return out;
}

/** Trust is granted to exactly this configuration: the project's hooks, allow rules and MCP servers. */
export function projectFingerprint(
  hooks: readonly HookCommand[],
  allow: readonly string[],
  mcp: readonly McpServerSpec[] = [],
  commands: ReadonlyArray<{ name: string; lines: string[]; allowedTools: string[] }> = [],
  plugins: Record<string, unknown> = {},
  verify: ReadonlyArray<{ file: string; content: string }> = [],
): string {
  const parts: unknown[] = [
    hooksFingerprint(hooks),
    allow,
    mcp.map(mcpIdentity),
    commands,
    plugins,
  ];
  // Only when there is one, so a project trusted before verify scripts counted keeps its trust.
  if (verify.length > 0) parts.push(verify);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function saveTrust(file: string, workspaceRoot: string, fingerprint: string | undefined): void {
  const { [workspaceRoot]: _previous, ...others } = readTrust(file);
  const next = fingerprint === undefined ? others : { ...others, [workspaceRoot]: fingerprint };
  mkdirSync(dirname(file), { recursive: true });
  // A fresh name created exclusively (never through a file or link already there), removed if the save fails.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Plugin ids (`name@marketplace`) as short lines: grouped by where they come from, names wrapped. */
function pluginLines(ids: string[], width = 88): string[] {
  const byMarket = new Map<string, string[]>();
  for (const id of ids) {
    const at = id.lastIndexOf("@");
    const market = at > 0 ? id.slice(at + 1) : "";
    const name = at > 0 ? id.slice(0, at) : id;
    byMarket.set(market, [...(byMarket.get(market) ?? []), visible(name)]);
  }
  const out: string[] = [];
  for (const [market, names] of byMarket) {
    let line = `   ${market ? `from ${visible(market)}:` : ""}`;
    for (const [i, name] of names.entries()) {
      const piece = i < names.length - 1 ? `${name},` : name;
      if (line.length + 1 + piece.length > width && line.trim().length > 0) {
        out.push(line);
        line = `    ${piece}`;
      } else line = line.trim().length > 0 ? `${line} ${piece}` : `${line}${piece}`;
    }
    out.push(line);
  }
  return out;
}

const HOOK_SOURCE: Record<HookCommand["source"], string> = {
  ambient: "ambient config",
  project: "this project (.claude/settings)",
  "claude-user": "~/.claude/settings.json",
  plugin: "a Claude Code plugin",
};

function describeHook(h: HookCommand): string {
  const on = h.matcher && h.matcher !== "*" ? `${h.event}(${visible(h.matcher)})` : h.event;
  const cmd = h.command.length > 70 ? `${h.command.slice(0, 69)}…` : h.command;
  return `  ${on} → ${visible(cmd)}`;
}

interface Snapshot {
  activeHooks: HookCommand[];
  waitingHooks: HookCommand[];
  offHooks: number;
  rules: PermissionRules;
  ruleSources: Array<{ label: string; lists: RuleLists; allowApplies: boolean }>;
  waitingAllow: string[];
  offAllow: number;
  projectHooks: HookCommand[];
  projectAllow: string[];
  projectMcp: McpServerSpec[];
  projectCommands: Array<{ name: string; lines: string[]; allowedTools: string[] }>;
  projectPlugins: Record<string, unknown>;
  projectVerify: Array<{ file: string; content: string }>;
  trusted: boolean;
}

/** How many things of the project's own trust covers. */
const projectItems = (s: Snapshot) =>
  s.projectHooks.length +
  s.projectAllow.length +
  s.projectMcp.length +
  s.projectCommands.length +
  Object.keys(s.projectPlugins).length +
  s.projectVerify.length;

/** The workspace's settings, re-read on every use so edits and trust changes apply without a restart. */
export interface WorkspaceSettings {
  /** The hooks for the next run (undefined when none would run). */
  hooksPort(sessionId: () => string): HooksPort | undefined;
  /** The permission rules for the next run (undefined when there are none). */
  rules(): PermissionRules | undefined;
  /** What `/hooks` shows. */
  hooksSummary(): string[];
  /** What `/permissions` shows. */
  permissionsSummary(): string[];
  /** What the project's own settings would add if trusted (for review before `/trust yes`). */
  trustSummary(): string[];
  /** Trust the project's current hooks and allow rules; returns what happened. */
  trust(): string;
  /** Stop trusting the project (its settings go back to off); returns what happened. */
  untrust(): string;
  /** How many project hooks, allow rules and MCP servers are waiting to be trusted. */
  untrustedCount(): number;
  /** Whether the project's own settings (hooks, allow rules, MCP servers) are trusted as they are now. */
  projectTrusted(): boolean;
}

export function makeWorkspaceSettings(opts: {
  workspaceRoot: string;
  config: SettingsConfig;
  trustFile: string;
  home?: string;
}): WorkspaceSettings {
  const home = opts.home ?? homedir();
  const claude = opts.config.claudeSettings === true;

  const snapshot = (): Snapshot => {
    const hooks = discoverHooks({
      workspaceRoot: opts.workspaceRoot,
      home,
      ambientSettings: opts.config.hooks ? { hooks: opts.config.hooks } : undefined,
    });
    const lists = discoverRuleLists({ workspaceRoot: opts.workspaceRoot, home });
    const ambient: RuleLists = {
      allow: opts.config.permissions?.allow ?? [],
      deny: opts.config.permissions?.deny ?? [],
      ask: opts.config.permissions?.ask ?? [],
    };
    const projectMcp = loadMcpConfig(opts.workspaceRoot, process.env, home).filter(
      (m) => m.source === "project",
    );
    const projectCommands = projectShellCommands(opts.workspaceRoot, home);
    const projectPlugins = projectEnabledPlugins(opts.workspaceRoot, home);
    const projectVerify = verifyScripts(opts.workspaceRoot);
    const trusted =
      (hooks.project.length > 0 ||
        lists.project.allow.length > 0 ||
        projectMcp.length > 0 ||
        projectCommands.length > 0 ||
        Object.keys(projectPlugins).length > 0 ||
        projectVerify.length > 0) &&
      readTrust(opts.trustFile)[opts.workspaceRoot] ===
        projectFingerprint(
          hooks.project,
          lists.project.allow,
          projectMcp,
          projectCommands,
          projectPlugins,
          projectVerify,
        );
    // Plugin hooks only count the project's own plugin choices once the project is trusted.
    const pluginHooks =
      claude && trusted
        ? discoverHooks({ workspaceRoot: opts.workspaceRoot, home, projectPlugins: true }).plugins
        : hooks.plugins;
    const ruleSources = [
      { label: "ambient config", lists: ambient, allowApplies: true },
      { label: "this project (.claude/settings)", lists: lists.project, allowApplies: trusted },
      { label: "~/.claude/settings.json", lists: lists.claudeUser, allowApplies: claude },
    ];
    const all = (k: keyof RuleLists) => ruleSources.flatMap((s) => s.lists[k]);
    return {
      activeHooks: [
        ...hooks.ambient,
        ...(trusted ? hooks.project : []),
        ...(claude ? [...hooks.claudeUser, ...pluginHooks] : []),
      ],
      waitingHooks: trusted ? [] : hooks.project,
      offHooks: claude ? 0 : hooks.claudeUser.length + hooks.plugins.length,
      rules: {
        allow: parseRules(ruleSources.filter((s) => s.allowApplies).flatMap((s) => s.lists.allow)),
        deny: parseRules(all("deny")),
        ask: parseRules(all("ask")),
      },
      ruleSources,
      waitingAllow: trusted ? [] : lists.project.allow,
      offAllow: claude ? 0 : lists.claudeUser.allow.length,
      projectHooks: hooks.project,
      projectAllow: lists.project.allow,
      projectMcp,
      projectCommands,
      projectPlugins,
      projectVerify,
      trusted,
    };
  };

  const trustHint = (lines: string[], s: Snapshot) => {
    const waiting = s.waitingHooks.length + s.waitingAllow.length;
    if (waiting === 0) return;
    lines.push(
      "Review them with /trust (ambient trust in a shell). A later change needs trusting again.",
    );
  };
  const gap = (lines: string[]) => {
    if (lines.length > 0) lines.push("");
  };

  return {
    hooksPort: (sessionId) => hooksPort(snapshot().activeHooks, opts.workspaceRoot, sessionId),
    rules() {
      const { rules } = snapshot();
      return rules.allow.length + rules.deny.length + rules.ask.length > 0 ? rules : undefined;
    },
    hooksSummary() {
      const s = snapshot();
      const lines: string[] = [];
      if (s.activeHooks.length === 0 && s.waitingHooks.length === 0)
        lines.push("No hooks will run.");
      else if (s.activeHooks.length > 0) {
        lines.push(`${plural(s.activeHooks.length, "hook")} will run:`);
        for (const source of Object.keys(HOOK_SOURCE) as HookCommand["source"][]) {
          const group = s.activeHooks.filter((h) => h.source === source);
          if (group.length === 0) continue;
          lines.push(` From ${HOOK_SOURCE[source]}:`);
          for (const h of group) lines.push(describeHook(h));
        }
      }
      const waiting = s.waitingHooks.length;
      if (waiting > 0) {
        gap(lines);
        lines.push(
          `This project has ${plural(waiting, "hook")} that won't run until you trust ${waiting === 1 ? "it" : "them"}:`,
        );
        for (const h of s.waitingHooks) lines.push(describeHook(h));
        trustHint(lines, s);
      }
      if (s.offHooks > 0) {
        gap(lines);
        lines.push(
          `${plural(s.offHooks, "hook")} from ~/.claude and plugins ${s.offHooks === 1 ? "is" : "are"} off ("claudeSettings": true turns ${s.offHooks === 1 ? "it" : "them"} on).`,
        );
      }
      return lines;
    },
    permissionsSummary() {
      const s = snapshot();
      const lines: string[] = [];
      const legacy = opts.config.allow ?? [];
      if (legacy.length > 0) {
        lines.push(
          `From ambient config ("allow"): ${legacy.join(" · ")} — these tools run without asking`,
        );
      }
      for (const src of s.ruleSources) {
        const { allow, deny, ask } = src.lists;
        if (allow.length + deny.length + ask.length === 0) continue;
        gap(lines);
        lines.push(`From ${src.label}:`);
        if (deny.length > 0) lines.push(`  deny   ${visible(deny.join(" · "))}`);
        if (ask.length > 0) lines.push(`  ask    ${visible(ask.join(" · "))}`);
        if (allow.length > 0) {
          const why = src.allowApplies
            ? ""
            : src.label.startsWith("~")
              ? '  (off: set "claudeSettings")'
              : "  (waits for /trust)";
          lines.push(`  allow  ${visible(allow.join(" · "))}${why}`);
        }
      }
      if (lines.length === 0) {
        lines.push(
          'No permission rules. Add them under "permissions" in ambient\'s config, e.g.',
          '  {"permissions": {"allow": ["Bash(npm test:*)"], "deny": ["Read(./.env)"]}}',
        );
      }
      return lines;
    },
    untrustedCount() {
      const s = snapshot();
      return s.trusted ? 0 : projectItems(s);
    },
    projectTrusted: () => snapshot().trusted,
    trustSummary() {
      const s = snapshot();
      if (projectItems(s) === 0)
        return ["This folder has no settings of its own to trust — nothing is waiting for you."];
      const lines: string[] = [
        s.trusted
          ? "This folder's own settings are trusted, so they're ON:"
          : "This folder has settings of its own. They're OFF until you trust them:",
      ];
      // Everything is shown in full (nothing cut short), with control characters made visible, so what you
      // trust is exactly what you read.
      if (s.projectHooks.length > 0) {
        lines.push(" Hooks (commands that run on your machine):");
        for (const h of s.projectHooks) {
          const on = h.matcher && h.matcher !== "*" ? `${h.event}(${visible(h.matcher)})` : h.event;
          lines.push(`  ${on} → ${visible(h.command)}`);
        }
      }
      if (s.projectAllow.length > 0) {
        lines.push(" Allow rules (calls that run without asking):");
        for (const r of s.projectAllow) lines.push(`  ${visible(r)}`);
      }
      if (s.projectMcp.length > 0) {
        lines.push(" MCP servers (as configured):");
        for (const m of s.projectMcp) {
          lines.push(`  ${m.name} → ${visible(JSON.stringify(m.raw ?? {}))}`);
          const sent = sentVariables(m);
          if (sent.length > 0 && m.url) {
            lines.push(
              `    sends the values of ${sent.map((v) => `$${visible(v)}`).join(", ")} to ${visible(hostOf(m.url))}`,
            );
          }
        }
      }
      const pluginChoices = Object.entries(s.projectPlugins);
      for (const on of [true, false]) {
        const ids = pluginChoices.filter(([, v]) => (v === true) === on).map(([id]) => id);
        if (ids.length === 0) continue;
        lines.push(` Claude Code plugins it turns ${on ? "on" : "off"} (${ids.length}):`);
        lines.push(...pluginLines(ids));
      }
      if (s.projectCommands.length > 0) {
        lines.push(" Commands that run shell lines when you use them:");
        for (const c of s.projectCommands) {
          const allowed =
            c.allowedTools.length > 0 ? ` (allows ${visible(c.allowedTools.join(", "))})` : "";
          lines.push(`  /${c.name}${allowed}:`);
          for (const l of c.lines) lines.push(`    ${visible(l)}`);
        }
      }
      for (const v of s.projectVerify) {
        lines.push(` Verify script ${v.file} (runs after the agent changes files):`);
        for (const l of v.content.replace(/\n$/, "").split("\n")) lines.push(`    ${visible(l)}`);
      }
      lines.push(
        "",
        ...(s.trusted
          ? ["/trust no     turn them off again"]
          : [
              "/trust yes    turn on exactly what's listed",
              "do nothing    they stay off — ambient works as usual without them",
              "(If this folder's settings change later, they go back to off until you trust them again.)",
            ]),
      );
      return lines;
    },
    trust() {
      const s = snapshot();
      const hooks = s.projectHooks.length;
      const allow = s.projectAllow.length;
      const mcp = s.projectMcp.length;
      const cmds = s.projectCommands.length;
      const plugins = Object.keys(s.projectPlugins).length;
      const verify = s.projectVerify.length;
      if (projectItems(s) === 0) return "This folder has no settings of its own to trust.";
      if (s.trusted) return "This project's settings are already trusted.";
      try {
        saveTrust(
          opts.trustFile,
          opts.workspaceRoot,
          projectFingerprint(
            s.projectHooks,
            s.projectAllow,
            s.projectMcp,
            s.projectCommands,
            s.projectPlugins,
            s.projectVerify,
          ),
        );
      } catch (e) {
        return `Couldn't save the trust setting: ${(e as Error).message}`;
      }
      const parts = [
        ...(hooks > 0 ? [plural(hooks, "hook")] : []),
        ...(allow > 0 ? [plural(allow, "allow rule")] : []),
        ...(mcp > 0 ? [plural(mcp, "MCP server")] : []),
        ...(cmds > 0 ? [plural(cmds, "shell command")] : []),
        ...(plugins > 0 ? [plural(plugins, "plugin setting")] : []),
        ...(verify > 0 ? ["verify script"] : []),
      ];
      const list =
        parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
      const when =
        cmds + hooks + allow + verify === 0
          ? "on from the next time ambient starts"
          : mcp > 0
            ? "on from your next message (MCP servers: next launch)"
            : "on from your next message or run";
      return `Trusted this folder's ${list} — ${when}. /trust no turns them off again.`;
    },
    untrust() {
      if (!(opts.workspaceRoot in readTrust(opts.trustFile)))
        return "This folder isn't trusted — its own settings are already off.";
      try {
        saveTrust(opts.trustFile, opts.workspaceRoot, undefined);
      } catch (e) {
        return `Couldn't save the trust setting: ${(e as Error).message}`;
      }
      const mcp = snapshot().projectMcp.length > 0 ? " (its MCP servers: after a restart)" : "";
      return `This folder's own settings are off again${mcp}. /trust shows them.`;
    },
  };
}

/** The workspace's settings as ambient's config sets them up (the one place CLI entry points build them). */
export function workspaceSettings(
  workspaceRoot: string,
  config: SettingsConfig,
  configFolder: string,
): WorkspaceSettings {
  return makeWorkspaceSettings({ workspaceRoot, config, trustFile: trustFilePath(configFolder) });
}

/** A one-line heads-up when the project has settings that won't apply yet (headless runs can't ask). */
export function untrustedNote(settings: WorkspaceSettings): string | undefined {
  return settings.untrustedCount() > 0
    ? "This folder has settings of its own (plugins, hooks, rules or MCP servers) — off until trusted: ambient trust"
    : undefined;
}
