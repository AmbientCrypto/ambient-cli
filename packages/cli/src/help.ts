/** The CLI's help text, and help for one command. */

export const HELP = `ambient — Ambient CLI (a terminal coding agent for the Ambient network)

Usage:
  ambient                                Launch the interactive TUI (in a terminal)
  ambient login                          Sign in — opens your keys page, checks + saves your key securely
  ambient logout                         Remove the saved API key from this machine
  ambient tui ["<task>"] [flags]         Same — the Ambient-branded interactive UI
  ambient "<task>"                       Run the coding agent on a task (line UI)
  ambient run "<task>" [flags]           Same as above
  ambient -p "<task>" [flags]            Print only the answer; never prompts (scripts/CI)
  cmd | ambient "<task>"                 Pipe stdin in as context (cat err.log | ambient "explain")
  ambient chat "<prompt>" [--model <id>] Talk to a live Ambient model (no tools)
  ambient models [--json]                Show the live Ambient model fleet
  ambient skills [--json]                Scrape Claude + Codex + plugin skills the agent can use
  ambient skills show "<name>"           Print a discovered skill's full instructions
  ambient skills pin|unpin "<name>"      Pin a skill so it ALWAYS auto-loads (or unpin it)
  ambient hooks                          List the hooks that run here
  ambient trust [yes]                    Review, then trust, this project's own settings
  ambient mcp [login|logout <name>]      List MCP servers; sign in to one that uses OAuth
  ambient probe <model-id>               Test a model's native tool-calling (records the result)
  ambient route explain [model-id]       Explain which model + lane a task would use
  ambient sessions [show <id>]           List / inspect past sessions
  ambient resume [<id|latest> "<next>"]  Continue a prior session with a new instruction
  ambient rewind [<id|latest>] [N] [--yes] Revert the workspace to before the last N file-changing turns
  ambient eval [name] [flags]            Run the repo's private eval suite as a ship gate
  ambient config [show|path]             Show your ~/.config/amb/config.json defaults
  ambient github [status|login]          Show GitHub sign-in (or run 'gh auth login')
  ambient doctor                         Check your setup + network
  ambient help                           Show this help

Run flags:
  --model <id>        Pick a model (default: auto — best available from the live fleet)
  --goal "<text>"     Set a session north-star the agent keeps in view every turn
  --plan              Read-only: propose changes without making them
  --accept-edits      Auto-approve file edits (still confirms shell)
  --bypass, --yolo    Full autonomy: no approval prompts (incl. shell)
  --effort <level>    Reasoning effort: auto (default) | off | high | max
  --yes, -y           Auto-approve file edits (shell/network still prompt; use --bypass for those)
  --max-turns <n>     Turns per segment before an auto-continue checkpoint (1–1000, default 120)
  --no-auto-continue  Stop at the turn limit for a one-tap continue (default: auto-continue)
  --jsonl             Emit machine-readable JSONL events to stdout (for scripts/CI)

Scripts and CI (ambient -p "<task>" [flags]):
  -p, --print         Print only the answer; anything that would ask for approval is refused
  --output-format <f> text | json | stream-json
  --allowedTools "<rules>" / --disallowedTools "<rules>"   Allow or refuse calls for this run
  --append-system-prompt "<text>"                          Extra instructions for this run
  -c, --continue / -r, --resume <id>   Continue the latest conversation here / a session
  --permission-mode <m> default | plan | acceptEdits | bypassPermissions
  --mcp-config <file|json> [--strict-mcp-config]           MCP servers for this run

Eval flags:
  --model <id>        Model to evaluate (default: auto)
  --min-pass-rate <r> Fail (exit 1) if the pass rate is below r (0–1)
  --baseline          Compare to .ambient/evals/<name>.baseline.json; fail on any regression
  --save-baseline     Save this run as the baseline for future comparisons
  --json              Emit the full EvalReport as JSON (for CI)

Everything runs on Ambient models only.`;

/** The help lines for one command (all of the help when the command isn't listed). */
export function commandHelp(cmd: string): string {
  const name = cmd === "gh" ? "github" : cmd;
  const lines = HELP.split("\n").filter((l) => new RegExp(`^\\s+ambient ${name}\\b`).test(l));
  if (lines.length === 0) return HELP;
  // A command with its own flags section (`Eval flags:`) shows it too.
  const section = new RegExp(
    `\\n(${name[0]?.toUpperCase()}${name.slice(1)} flags:\\n(?:  .*\\n?)+)`,
  ).exec(HELP)?.[1];
  return `Usage:\n${lines.join("\n")}${section ? `\n\n${section.trimEnd()}` : ""}\n\nSee all commands: ambient help`;
}

/**
 * `ambient <command> --help` only ever shows help — it never runs the command (`logout --help` must not sign
 * you out). `run`, `tui` and `chat` print their own fuller usage.
 */
export function wantsCommandHelp(cmd: string | undefined, rest: readonly string[]): boolean {
  return (
    cmd !== undefined &&
    !["run", "tui", "chat"].includes(cmd) &&
    rest.some((a) => a === "--help" || a === "-h")
  );
}
