import type { SlashCommand } from "./components/SlashPalette.js";

/** Keyboard shortcuts, as shown by /help. */
export const KEYS: ReadonlyArray<[string, string]> = [
  ["enter", "send (while working: steer the agent)"],
  ["\\ then enter", "new line"],
  ["↑ / ↓", "previous prompts"],
  ["ctrl+r", "search previous prompts"],
  ["ctrl+a / ctrl+e", "start / end of line"],
  ["ctrl+u / ctrl+k", "delete to start / end of line"],
  ["ctrl+w", "delete the previous word"],
  ["alt+b / alt+f", "move back / forward a word"],
  ["ctrl+v", "paste an image"],
  ["tab", "switch plan / build"],
  ["shift+tab", "change permission"],
  ["ctrl+t", "show or hide reasoning"],
  ["ctrl+o", "expand the running subagents"],
  ["esc", "close a menu, or stop the run"],
  ["ctrl+c", "stop the run, or quit"],
];

/**
 * The /help text: every built-in command with what it does, then the keys, in two aligned columns. The
 * user's own commands (often dozens) are counted, not listed — the / menu browses them.
 */
export function helpText(commands: readonly SlashCommand[], ownCommands = 0): string {
  const cmdRows = commands.map((c) => [`${c.name}${c.args ? ` ${c.args}` : ""}`, c.desc] as const);
  const width = Math.max(...[...cmdRows, ...KEYS].map(([left]) => left.length)) + 2;
  const row = ([left, right]: readonly [string, string]) => `  ${left.padEnd(width)}${right}`;
  const own =
    ownCommands > 0
      ? [
          `  …plus ${ownCommands} of your own command${ownCommands === 1 ? "" : "s"} — type / to browse`,
        ]
      : [];
  return ["Commands", ...cmdRows.map(row), ...own, "", "Keys", ...KEYS.map(row)].join("\n");
}
