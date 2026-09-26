# Ambient CLI

A standalone terminal coding agent for the [**Ambient**](https://ambient.xyz) decentralized-inference
network — plan, edit, run, and ship code across *every* model in Ambient's live fleet.

```bash
ambient "add input validation to the signup handler and run the tests"
```

`ambient` runs a real coding agent on Ambient models: it reads and searches your repo, edits files with
conflict-safe diffs, runs commands, verifies its work, and streams the whole thing to your terminal — under a
permission model you control. Run it with no arguments to open the interactive TUI.

## Install

Requires **Node ≥ 20.18**. No compiler needed — the CLI ships as a single pre-built JavaScript bundle.

**Homebrew** (recommended):

```bash
brew install ambientcrypto/ambient/ambient-code
ambient                # first launch walks you through connecting your Ambient key
```

**Windows, Linux, or anywhere with Node** (npm):

```bash
npm install -g ambient-code
ambient
```

On Windows it runs in Windows Terminal, PowerShell or the classic console. Commands run in Git Bash when it's
installed (recommended), otherwise in PowerShell — ambient tells the model which one it's using.

**From source**:

```bash
git clone https://github.com/AmbientCrypto/ambient-cli && cd ambient-cli
./scripts/install.sh   # builds + puts `ambient` on your PATH (~/.local/bin)
```

### Your API key

The first time you run `ambient`, it opens [app.ambient.xyz/keys](https://app.ambient.xyz/keys), asks you
to paste a key (hidden), checks it with Ambient (free — no model runs), and saves it: in the macOS keychain,
a credentials file only you can read on Linux, or encrypted with your Windows account (DPAPI) on Windows. `AMBIENT_API_KEY` in your environment also works
and takes priority.

- If a key stops working (revoked or mistyped), ambient tells you and asks for a new one right in the TUI,
  then re-runs what you asked for.
- Switch keys any time with `/login` inside ambient (or `ambient login`); `/logout` / `ambient logout`
  removes the saved key. `ambient doctor` shows which key is in use (masked) and where it came from.

Browsing the fleet (`ambient models`) and `ambient doctor` need no key. `ambient` is the primary command;
`amb` is a shorter alias.

### Update

```bash
brew upgrade ambient-code                                                                    # Homebrew
npm install -g ambient-code@latest                                                          # npm
git pull && ./scripts/install.sh                                                             # from source
```

`ambient` checks for a newer release on launch (and in `ambient doctor`) and shows the right one-line update
command for how you installed it — cached, best-effort, and never blocking. Turn it off with `AMBIENT_NO_UPDATE_CHECK=1`
or `"checkUpdates": false` in `~/.config/amb/config.json`.

### Uninstall

```bash
brew uninstall ambient-code                # Homebrew
npm uninstall -g ambient-code              # npm
rm ~/.local/bin/ambient ~/.local/bin/amb   # from source
```

## What makes it different

- **Adapts to the live fleet.** Context window, output length, vision, tool calling and reasoning all come
  from Ambient's live model catalog, and every budget (compaction, tool output, instructions, subagent
  reports) scales with the model serving you — a 1M-context model gets proportionally more room than a 32K
  one, with no update to the CLI. Switch models mid-task with `/model`; the conversation is re-fitted to the
  new model at the next step. `ambient models` shows the whole fleet.
- **Works with *every* serveable model.** Models with native tool-calling use it directly; models without it
  are driven through a controller-assisted text protocol — not just the tool-capable ones.
- **Images for every model.** Attach a screenshot (paste a path, drag a file, or Ctrl+V). A model that can't
  see images gets it described by a vision model from the same fleet — you see it happen — and can ask
  follow-up questions about any image in the session. The agent can look at image files itself too (a
  screenshot it just took, a mockup) with `view_image`.
- **Honest reliability.** Substitution and failover are always visible and bounded; stalled streams are
  detected and retried; network errors say what happened; the transcript is crash-safe and resumable.
- **You hold the dial.** A two-axis control — **Plan ⇄ Build** (Tab) × **ask / accept-edits / bypass**
  (Shift+Tab) — with a diff-first approval prompt and a local risk classifier.
- **Honest reasoning effort.** `auto` (default) picks per turn — none for chat, high for work, max for
  planning, hard bugs, or after a failed check; `/effort` or `--effort off|high|max` pins it. These are the
  levels Ambient models actually serve.
- **Memory you control.** Start a line with `#` to save a note to the project's memory
  (`.ambient/MEMORY.md`) without a model call; `/memory all <note>` keeps one for every project. `/memory`
  lists them and `/memory forget <n>` removes one (`u<n>` for every-project notes). The agent also records
  what it learns there as it works.
- **A north-star you set.** `/goal` pins a session objective the agent keeps in view every turn (it survives
  compaction); the agent can propose a revision, but only you commit it.
- **Brings your setup.** Reads your existing `.claude/agents`, skills, slash commands, instruction files
  (`AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules`, with `@path` imports; a subfolder's own
  files join when the agent starts working there), and MCP servers (`.mcp.json`, `claude mcp add`, and Codex
  `config.toml`; stdio, Streamable HTTP and SSE; header or bearer-token auth from your environment, or OAuth
  sign-in with `/mcp login <server>`; their resources are readable and their prompts run as
  `/mcp__server__prompt`), so what you already use works on Ambient models. When your MCP servers bring more
  tools than the model has room for, it sees an index and loads the ones it needs on demand.
- **Hooks and permission rules, the Claude Code way.** Hook commands (`PreToolUse`, `PostToolUse`,
  `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification`)
  can block a tool call, rewrite its input, add context, or send the agent back to work. Rules like
  `Bash(npm test:*)`, `Read(./.env)`, `WebFetch(domain:docs.ambient.xyz)` or `mcp__github` allow, ask for,
  or deny matching calls (a deny always wins, even in bypass). Put both under `"hooks"` and `"permissions"`
  in `~/.config/amb/config.json`; deny and ask rules apply from any settings file. For example:
  `{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./check.sh"}]}]},
  "permissions": {"allow": ["Bash(npm test:*)"], "deny": ["Read(./.env)"]}}`
- **Nothing from a clone runs until you say so.** A project's own hooks and allow rules
  (`.claude/settings.json`, `settings.local.json`), its MCP servers (`.mcp.json`, `.ambient/mcp.json`), its
  verify script (`.ambient/verify`) and the shell lines in its slash commands apply once you've reviewed and
  trusted them (`/trust`, or `ambient trust`); any change needs trusting again. Read-only shell commands run
  without asking only when they stay inside the project, and git only when the repository can't make it run
  a program of its own. Your `~/.claude` hooks, allow rules and global instructions
  (`~/.claude/CLAUDE.md`, `~/.claude/rules`, `~/.codex/AGENTS.md`) and your enabled Claude Code plugins' hooks
  and MCP servers apply when you set `"claudeSettings": true`.
- **Background commands.** The agent can start a dev server, a watcher or a long build in the background,
  keep working, read its output as it goes, and stop it; it's told when one finishes. `/jobs` lists them,
  and they all stop when the session ends.
- **Subagents.** The agent can hand parts of a task to subagents — read-only scouts, a reviewer, or builders
  that edit — which run in parallel with their own context and report back. They get your MCP tools (scouts
  only the read-only ones), can ask you a question, and can run in the background while the agent keeps
  working; it reads their report before it answers.
- **Tools that know your files.** `read` returns a PDF's text page by page; `notebook_edit` changes Jupyter
  cells; `diagnostics` runs the project's own checkers (TypeScript, ESLint, Ruff, Cargo, Go) and returns
  errors by file and line; search uses ripgrep when it's installed.
- **Runs everywhere.** macOS, Linux and Windows (Git Bash or PowerShell), tested on all three.

## In the interactive TUI

The activity line narrates what the agent is actually doing — `Reading src/app.ts`, `Running pnpm test`,
`Thinking · max  ↓ 1.2k tok · 40 tok/s` — and how long it thought stays in the transcript.

```
/model [id]      switch model (also mid-task)      /compact [focus]  summarize the conversation now
/effort          auto · off · high · max           /context          how full the model's context is
/plan  /build    plan first, or just build         /usage            tokens sent and received this session
/goal <text>     a north-star kept every turn      /skills           browse and pin your skills
/attach <path>   attach an image                   /login  /logout   add, change or remove your API key
/tools           what the agent can use            /clear            start a fresh conversation
/memory          notes ambient keeps (# adds one)  /hooks            the hooks that run here
/permissions     your allow / ask / deny rules     /trust [yes]      review this project's own settings
/mcp             your MCP servers (/mcp login <name> signs in to one)
/jobs            background commands the agent started (/jobs kill <id>)
/help            every command and key             /quit
```

Keys: `↑`/`↓` previous prompts · `Ctrl+R` search them · `@` pick a file · `\` then Enter for a new line ·
`Ctrl+A/E/U/K/W` and `Alt+B/F` edit like a shell · `Ctrl+V` paste an image · `Tab` plan/build ·
`Shift+Tab` permission · `Ctrl+T` show reasoning · `Esc` stop. Your own Claude/Codex slash commands appear
in the `/` menu too. The terminal bell rings when an approval is waiting or a long run finishes
(`AMBIENT_BELL=0` turns it off).

## Commands

```
ambient                             Launch the interactive TUI
ambient "<task>"                    Run the coding agent on a task (line UI)
ambient run "<task>" [flags]        Same (--plan --accept-edits --bypass --effort --goal --model --jsonl …)
ambient chat "<prompt>" [--model]   Talk to a live Ambient model (no tools)
ambient models [--json]             Show the live model fleet with capability lanes
ambient probe <id>                  Test a model's native tool-calling (records evidence)
ambient route explain [id]          Explain which model + lane a task would use
ambient sessions [show <id>]        List / inspect past sessions
ambient resume [<id|latest> "<…>"]  Continue a prior session with a new instruction (any run flag works)
ambient rewind [<id|latest>] [N]    Revert the workspace to before the last N file-changing turns
ambient config [show|path]          Show your ~/.config/amb defaults
ambient hooks                       List the hooks that run here
ambient trust [yes]                 Review (then trust) this project's hooks, allow rules and MCP servers
ambient mcp [login|logout <name>]   List MCP servers; sign in to one that uses OAuth
ambient github [status|login]       Show GitHub sign-in (or run `gh auth login`)
ambient doctor                      Check your setup + network
ambient login | logout | help
```

Anything can be piped in as context: `cat error.log | ambient "explain this failure"`.

### Scripts and CI

The Claude Code headless flags work the same way:

```
ambient -p "why does the build fail?"                     print just the answer; never prompts
ambient -p "..." --output-format json                     one result object (stream-json: a line per step)
ambient -p "..." --allowedTools "Bash(npm test:*) Edit"   run these without asking
ambient -p "..." --disallowedTools "Bash(git push:*)"     refuse these
ambient -p "..." --append-system-prompt "Be terse."       extra instructions for this run
ambient -c -p "and now add docs"                          continue the latest conversation in this folder
ambient -r <session> -p "..."                             continue a specific session
ambient -p "..." --mcp-config servers.json                add MCP servers (--strict-mcp-config: only these)
ambient -p "/review 42"                                   your custom commands and skills work here too
```

In print mode anything that would ask for approval is refused instead, so allow what the job needs. A project's
own hooks, allow rules and MCP servers apply only after `ambient trust yes` has been run in that folder on that
machine.

## Architecture

A TypeScript/pnpm monorepo split into a pure **harness** and a thin terminal **shell**:

`protocol` (Zod contracts + a hash-chained event log) · `ambient-api` (catalog + SSE transport) ·
`reliability` (ready/cold, output floors, 429, overflow) · `capabilities` (evidence ladder → lane) ·
`context` (token budgeting + compaction + repo map) · `permissions` (the mode ladder + risk classifier) ·
`tools-core` (read/edit/write/grep/glob/bash + web_fetch, symlink-safe) · `sessions` (crash-safe JSONL +
rewind blobs) · `mcp` (MCP client) · `evals` (the eval ship-gate) · `runtime` (the agent state machine +
the controller-assisted lane + subagents) · `cli` (the commands + Ink TUI).

The runtime is a **pure event producer**; the TUI is a **pure event consumer** over a **pure reducer**. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the engineering standards.

## Development

```bash
pnpm install
pnpm -r build           # → the single-file binary at packages/cli/dist/amb.js
pnpm test               # vitest
pnpm typecheck          # tsc across all packages
pnpm lint               # biome
```

## License

[MIT](./LICENSE). This is an original, clean-room implementation — not a fork of any coding agent. Where it
re-implements logic or borrows patterns, that's recorded in [`ATTRIBUTION.md`](./ATTRIBUTION.md) and
[`NOTICE`](./NOTICE).
