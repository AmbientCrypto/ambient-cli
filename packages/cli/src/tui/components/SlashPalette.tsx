import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { fuzzyRank } from "../fuzzy.js";
import { AmbientTheme } from "../theme.js";

export interface SlashCommand {
  name: string;
  args?: string;
  desc: string;
}

/** The command palette shown when the composer text starts with `/`. Kept small + memorable. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", desc: "Show what ambient can do" },
  { name: "/tools", desc: "List the tools the agent can use" },
  { name: "/model", args: "[id]", desc: "Switch model (opens a picker)" },
  {
    name: "/effort",
    args: "[auto|off|high|max]",
    desc: "Reasoning effort (opens a picker)",
  },
  { name: "/plan", desc: "Plan mode — explore + build a task list, no changes" },
  { name: "/build", desc: "Build mode — execute the work" },
  { name: "/ask", desc: "Permission: approve each edit + command (default)" },
  { name: "/accept", desc: "Permission: auto-approve edits, still confirm shell" },
  { name: "/bypass", desc: "Permission: full autonomy — no prompts" },
  { name: "/thinking", desc: "Toggle the live model-reasoning view (also Ctrl+T)" },
  {
    name: "/goal",
    args: "<objective> | show | clear",
    desc: "Set a north-star the agent keeps in view every turn",
  },
  { name: "/attach", args: "<path>", desc: "Attach an image (or press Ctrl+V to paste one)" },
  { name: "/skills", desc: "Show your skills + how the agent uses them" },
  {
    name: "/compact",
    args: "[focus]",
    desc: "Summarize the conversation so far to free up context",
  },
  { name: "/context", desc: "How full the model's context is and when it compacts" },
  { name: "/usage", desc: "Tokens sent and received this session" },
  {
    name: "/hooks",
    desc: "The hooks that run on this project",
  },
  { name: "/permissions", desc: "Your allow / ask / deny rules and where they come from" },
  {
    name: "/mcp",
    args: "[login <server>]",
    desc: "Your MCP servers; sign in to one that needs it",
  },
  { name: "/jobs", args: "[kill <id>]", desc: "Background commands the agent started" },
  {
    name: "/memory",
    args: "[all|forget]",
    desc: "Notes ambient keeps (start a line with # to add one)",
  },
  {
    name: "/trust",
    args: "[yes]",
    desc: "Review, then trust, this project's hooks, rules, MCP servers and verify script",
  },
  { name: "/login", desc: "Add or change your Ambient API key (checked before saving)" },
  { name: "/logout", desc: "Remove the saved API key from this machine" },
  { name: "/clear", desc: "Clear the screen and start a fresh conversation" },
  { name: "/quit", desc: "Exit ambient" },
];

/** The commands matching the current `/…` prefix — builtins PLUS any discovered (Claude/Codex) commands.
 *  An EXACT name match is surfaced FIRST (so pressing Enter on `/deploy` never runs `/deployment`), and a
 *  name is de-duplicated (a discovered command can't produce two identical rows / shadow a builtin twice). */
export function matchSlash(input: string, extra: SlashCommand[] = []): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const token = (input.slice(1).split(/\s/, 1)[0] ?? "").toLowerCase();
  const seen = new Set<string>();
  const matched: SlashCommand[] = [];
  for (const c of [...SLASH_COMMANDS, ...extra]) {
    const name = c.name.slice(1).toLowerCase();
    if (seen.has(name) || !name.startsWith(token)) continue; // first (builtins win) + prefix filter
    seen.add(name);
    matched.push(c);
  }
  // Loose matching only for a lone command-shaped word: text after it means the user is writing a prompt.
  const lone = !/\s/.test(input.slice(1).trim());
  if (matched.length === 0 && lone && isFuzzyToken(token)) return fuzzySlash(token);
  // Exact match first, then the rest in their original (builtins-then-discovered) order.
  return matched.sort((a, b) => {
    const ae = a.name.slice(1).toLowerCase() === token ? 0 : 1;
    const be = b.name.slice(1).toLowerCase() === token ? 0 : 1;
    return ae - be;
  });
}

/** Loose matching is for command-shaped typos only: a path (`/tmp/x`, `/Users/me`) must never pick a command. */
function isFuzzyToken(token: string): boolean {
  return token.length >= 2 && /^[a-z0-9:_-]+$/.test(token);
}

/** Commands a loose match must never pick: they concern permissions, sign out, or end the session. */
const EXACT_ONLY = new Set([
  "/bypass",
  "/accept",
  "/ask",
  "/permissions",
  "/hooks",
  "/trust",
  "/logout",
  "/login",
  "/clear",
  "/quit",
]);

/**
 * No prefix hit → rank the built-in commands by a loose in-order match (e.g. `/thnk` → `/thinking`). The
 * user's own discovered commands and anything with side effects need their exact name.
 */
function fuzzySlash(token: string): SlashCommand[] {
  return fuzzyRank(
    token,
    SLASH_COMMANDS.filter((c) => !EXACT_ONLY.has(c.name)),
    (c) => c.name.slice(1),
  );
}

/**
 * The floating command list above the composer. `selected` is highlighted; ↑/↓ move it, Enter/Tab runs it.
 * Rendered only when there are matches (App decides).
 */
export function SlashPalette({
  commands,
  selected,
  width,
}: {
  commands: SlashCommand[];
  selected: number;
  width: number;
}): ReactNode {
  if (commands.length === 0) return null;
  const boxW = Math.max(0, Math.min(width - 2, 120));
  // Window to at most 8 rows around the selection so a bare `/` (all commands) can't get tall.
  const max = 8;
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(max / 2), Math.max(0, commands.length - max)),
  );
  const shown = commands.slice(start, start + max);
  const above = start;
  const below = commands.length - (start + shown.length);
  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={2}
    >
      <Text color={AmbientTheme.dim} wrap="truncate">
        Commands · ↑/↓ then enter · esc to cancel
      </Text>
      {above > 0 ? <Text color={AmbientTheme.dim}>{`  … ${above} above`}</Text> : null}
      {shown.map((c, k) => {
        const active = start + k === selected;
        const name = c.args ? `${c.name} ${c.args}` : c.name;
        return (
          // fixed cursor + name columns (matching Approval + the other pickers) → a straight desc edge; the
          // ▸ glyph carries selection so it survives NO_COLOR.
          <Box key={c.name}>
            <Box width={2} flexShrink={0}>
              <Text color={AmbientTheme.cyan}>{active ? "▸ " : "  "}</Text>
            </Box>
            {/* 1-col gutter after the name column, so a truncated name never runs into its description */}
            <Box width={22} flexShrink={0} marginRight={1}>
              <Text
                color={active ? AmbientTheme.cyan : AmbientTheme.dim}
                bold={active}
                wrap="truncate"
              >
                {name}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={AmbientTheme.dim} wrap="truncate">
                {c.desc}
              </Text>
            </Box>
          </Box>
        );
      })}
      {below > 0 ? <Text color={AmbientTheme.dim}>{`  … ${below} below`}</Text> : null}
    </Box>
  );
}
