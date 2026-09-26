import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Grant, Mode } from "@amb/protocol";
import { normalizeEffortSetting } from "@amb/runtime";
import { z } from "zod";

/**
 * Persistent user config for `amb`, at ~/.config/amb/config.json (or $XDG_CONFIG_HOME/amb, or $AMB_CONFIG_HOME
 * for tests). Every field is OPTIONAL — the file only sets DEFAULTS; an explicit flag or env var always wins.
 * A missing file is normal (all built-in defaults). A malformed file WARNS and is ignored, never fatal — a
 * typo in a dotfile must not brick the CLI.
 */
export const AmbConfigSchema = z
  .object({
    /** Default requested model id (same as --model). "auto" / omitted ⇒ best live pick. */
    model: z.string().min(1).optional(),
    /** Default reasoning effort (same as --effort). */
    effort: z
      .string()
      .transform((v, ctx) => {
        const n = normalizeEffortSetting(v);
        if (!n) {
          ctx.addIssue({ code: "custom", message: "effort must be auto, off, high or max" });
          return z.NEVER;
        }
        return n.setting;
      })
      .optional(),
    /** Default permission mode (same as --plan/--accept-edits/--bypass). Drives BOTH UIs. */
    mode: z.enum(["plan", "ask", "accept-edits", "bypass"]).optional(),
    /** Default turns per segment before a budget checkpoint (same as --max-turns). */
    maxTurns: z.number().int().min(1).max(1000).optional(),
    /** Auto-continue past the turn limit (compact + keep going, no keypress) while making progress. Default
     *  true (the CLI just works). Set false for a one-tap manual continue at each checkpoint. */
    autoContinue: z.boolean().optional(),
    /** How many extra segments auto-continue may add before the hard ceiling. Default 3. */
    maxAutoContinues: z.number().int().min(0).max(20).optional(),
    /** Skip connecting MCP servers by default (same as --no-mcp). */
    noMcp: z.boolean().optional(),
    /** Check for a newer published version on startup and show an upgrade hint. Default true; set false (or
     *  env AMBIENT_NO_UPDATE_CHECK) to disable the network check. */
    checkUpdates: z.boolean().optional(),
    /** Tool names to AUTO-ALLOW without prompting (a persistent allowlist). Powerful — listing "bash" here
     *  lets the agent run ANY shell command unprompted. Your file, your choice; empty/omitted ⇒ prompt as
     *  usual. Seeded as session-scoped grants at run start. */
    allow: z.array(z.string().min(1)).optional(),
    /** Hooks in Claude Code's format (`{"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command",
     *  "command": "…"}]}]}`). These always run. */
    hooks: z.record(z.string(), z.array(z.unknown())).optional(),
    /** Permission rules in Claude Code's syntax: `allow` answers the approval question for matching calls,
     *  `ask` always asks, `deny` always refuses (e.g. "Bash(npm test:*)", "Read(./.env)",
     *  "WebFetch(domain:docs.ambient.xyz)", "mcp__github"). */
    permissions: z
      .object({
        allow: z.array(z.string().min(1)).optional(),
        deny: z.array(z.string().min(1)).optional(),
        ask: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    /** Also use the hooks and allow rules from ~/.claude/settings.json and enabled Claude Code plugins. Off by
     *  default: they're written for Claude Code and may not suit ambient. Deny and ask rules always apply. */
    claudeSettings: z.boolean().optional(),
  })
  // Unknown keys are stripped (default) rather than rejected, so a future field in an older binary is tolerated.
  .strip();

export type AmbConfig = z.infer<typeof AmbConfigSchema>;

/** The folder ambient's config lives in (the config file, trusted hooks). */
export function configDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.AMB_CONFIG_HOME ?? env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "amb");
}

/** The config file path, honoring $AMB_CONFIG_HOME then $XDG_CONFIG_HOME then ~/.config. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), "config.json");
}

/**
 * Load + validate the config. Returns {} for a missing file; WARNS to stderr and returns {} for unreadable /
 * non-JSON / schema-invalid content (never throws). `warn` is injectable for tests.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): AmbConfig {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn(`ambient: ignoring ${path} — not valid JSON`);
    return {};
  }
  const parsed = AmbConfigSchema.safeParse(raw);
  if (!parsed.success) {
    warn(
      `ambient: ignoring invalid ${path} — ${parsed.error.issues[0]?.message ?? "schema error"}`,
    );
    return {};
  }
  return parsed.data;
}

/** The (agentMode, permission) axis pair a config `mode` maps to for the TUI. Plan is the read-only agent
 *  mode; the rest ride the permission axis with agentMode=build. Pure. */
export function tuiAxesFromMode(mode: Mode): {
  agentMode: "build" | "plan";
  permission: "ask" | "accept-edits" | "bypass";
} {
  if (mode === "plan") return { agentMode: "plan", permission: "ask" };
  return { agentMode: "build", permission: mode };
}

/** Seed session-scoped grants from the config allowlist (the user's explicit auto-allow choice). */
export function grantsFromConfig(config: AmbConfig): Grant[] {
  return (config.allow ?? []).map((toolName) => ({ scope: "session" as const, toolName }));
}
