import os from "node:os";
import {
  type AmbientConfig,
  KEYS_URL,
  fetchCatalog,
  resolveConfig,
  verifyApiKey,
} from "@amb/ambient-api";
import { discoverSkills, pinSkill, readPinnedSkills, skillSource, unpinSkill } from "@amb/context";
import type { Grant, ToolDefinition } from "@amb/protocol";
import { SessionWriter, ambHome } from "@amb/sessions";
import { render } from "ink";
import { createElement } from "react";
import { AmbientChatClient } from "../agent/ambient-client.js";
import { makeCapabilityPort } from "../agent/capability-port.js";
import { listWorkspaceFiles } from "../agent/file-list.js";
import { fireAndForget } from "../agent/hooks.js";
import { makeMcpControl } from "../agent/mcp-control.js";
import { makeMemoryPort } from "../agent/memory-port.js";
import { type SettingsConfig, workspaceSettings } from "../agent/workspace-settings.js";
import { openBrowser, signInInteractive } from "../commands/login.js";
import { configDir } from "../config.js";
import { type FleetRow, formatFleetRows, laneResolver } from "../render/fleet.js";
import {
  KEY_SOURCE_LABEL,
  NOT_SIGNED_IN,
  apiKeyCandidates,
  deleteApiKey,
  maskKey,
  resolveApiKey,
  resolveApiKeyWithSource,
  saveApiKey,
} from "../secrets.js";
import { checkForUpdate, updateCommand } from "../update-check.js";
import { CURRENT_VERSION } from "../version.js";
import { App } from "./App.js";
import { installAsciiFallback, needsAsciiFallback } from "./ascii-console.js";
import { appendHistory, historyPath, loadHistory } from "./history.js";
import { checkStartupKey } from "./startup-key.js";
import type { AgentMode, Effort, Permission } from "./state.js";
import type { AccountPort } from "./use-key-prompt.js";

// We DON'T use the alternate screen buffer: settled turns are committed to the terminal's real scrollback
// (via Ink's <Static>) so the user can scroll back through history with the trackpad/wheel like a normal
// terminal log, so history stays scrollable. The alt-screen has no scrollback.
// Bracketed paste: the terminal wraps a paste in \x1b[200~ … \x1b[201~ so it arrives as ONE coherent burst
// (an embedded newline can't submit early, and a large paste can't be split into a stray Enter). The App
// strips the wrapping markers via normalizePastedText, so they never reach the buffer.
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";

export interface TuiOptions {
  agentMode: AgentMode;
  permission: Permission;
  effort: Effort;
  requestedModel: string;
  maxTurns: number;
  /** Auto-continue past the turn limit (compact + keep going, no keypress). Default true. */
  autoContinue?: boolean;
  /** How many extra segments auto-continue may add before the hard ceiling. */
  maxAutoContinues?: number;
  initialTask?: string;
  /** Skip connecting the user's MCP servers entirely (lean, instant start with only the built-in tools). */
  noMcp?: boolean;
  /** Session grants seeded from the config allowlist (auto-allow those tools without prompting). */
  initialGrants?: Grant[];
  /** A north-star goal to start the session with (`--goal`) — shown pinned + threaded into every run. */
  initialGoal?: string;
  /** Check for a newer published version and show an upgrade hint in the splash (config `checkUpdates`). */
  checkUpdates?: boolean;
  /** Hooks and permission rules from ambient's config. */
  settingsConfig?: SettingsConfig;
}

/** Fetch the live fleet (sorted rows) for the splash count + the model picker — best-effort, never blocks long. */
async function fleetSummary(config: AmbientConfig): Promise<FleetRow[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const models = await fetchCatalog(config, { signal: controller.signal });
    return formatFleetRows(models, laneResolver());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Launch the interactive Ink TUI. Requires a TTY (falls back with a hint otherwise). */
export async function runTui(opts: TuiOptions): Promise<void> {
  let apiKey = resolveApiKey();
  // First launch with no key: walk the user through signing in right here, then continue into the CLI —
  // no separate command to discover. A non-interactive shell gets the one-line instructions instead.
  if (!apiKey && process.stdin.isTTY && process.stdout.isTTY) {
    if (await signInInteractive({ firstRun: true })) apiKey = resolveApiKey();
  }
  if (!apiKey) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`);
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'ambient: the TUI needs an interactive terminal. Use `ambient "<task>"` for non-interactive runs.\n',
    );
    process.exitCode = 1;
    return;
  }

  const config: AmbientConfig = { baseUrl: resolveConfig().baseUrl, apiKey };
  const client = new AmbientChatClient(config);
  // Account effects for the in-app key flow. The saved key is checked in the background at launch (free — no
  // model runs), so a revoked key is caught before the first request instead of failing mid-task.
  const account: AccountPort = {
    keysUrl: KEYS_URL,
    verify: (key) => verifyApiKey({ baseUrl: config.baseUrl, apiKey: key }),
    save: (key) => {
      saveApiKey(key);
      client.setApiKey(key);
    },
    remove: () => {
      deleteApiKey();
      // Another key may still apply (the environment, or a key saved by another Ambient app) — say which.
      const next = resolveApiKeyWithSource();
      client.setApiKey(next?.key ?? "");
      return next
        ? `Removed the saved key. Still signed in with ${maskKey(next.key)} from ${KEY_SOURCE_LABEL[next.source]}.`
        : "Signed out on this machine. Type /login to add a key.";
    },
    openKeysPage: () => openBrowser(KEYS_URL),
    mask: maskKey,
    envKeyOverrides: Boolean(process.env.AMBIENT_API_KEY?.trim()),
    useKey: (key) => client.setApiKey(key),
    sourceLabel: (source) => KEY_SOURCE_LABEL[source],
    startupCheck: checkStartupKey(
      resolveApiKeyWithSource() ?? { key: apiKey, source: "env" },
      apiKeyCandidates(),
      (key) => verifyApiKey({ baseUrl: config.baseUrl, apiKey: key }),
    ),
  };
  const cwd = process.cwd();
  // Fetch the fleet and the update check together so neither adds latency to the splash. The update check is
  // cached (at most one network call per 6h) and fully best-effort — it never blocks or fails the launch.
  const [fleet, updateInfo] = await Promise.all([
    fleetSummary(config),
    checkForUpdate({ enabled: opts.checkUpdates }),
  ]);
  const update = updateInfo?.updateAvailable
    ? { latest: updateInfo.latest, command: updateCommand() }
    : undefined;
  // Skills for the `/skills` summary + interactive browser — a fast fs scan at the edge (the App never
  // touches the filesystem). `onTogglePin` writes the pin list and returns the new pinned state.
  const pinnedNames = new Set(readPinnedSkills(cwd));
  const skillRows = discoverSkills(cwd).map((s) => ({
    name: s.name,
    source: skillSource(s.path),
    description: s.description,
    pinned: pinnedNames.has(s.name),
    ...(s.userInvocable === false ? { userInvocable: false } : {}),
    ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
  }));
  const skillsInfo = { total: skillRows.length, pinned: pinnedNames.size };
  const onTogglePin = (name: string): boolean => {
    if (pinnedNames.has(name)) {
      unpinSkill(name);
      pinnedNames.delete(name);
      return false;
    }
    pinSkill(name);
    pinnedNames.add(name);
    return true;
  };

  // MCP connects in the BACKGROUND (kicked off after render, below) so the UI appears INSTANTLY instead of
  // blocking ~30s while a big MCP suite (10+ servers) spawns. Tools attach to the next run once ready; the
  // holder is read live via getMcpTools. `--no-mcp` / AMBIENT_NO_MCP skips MCP entirely for the leanest start.
  const skipMcp = opts.noMcp || process.env.AMBIENT_NO_MCP === "1";
  const settings = workspaceSettings(cwd, opts.settingsConfig ?? {}, configDir());
  const mcp = makeMcpControl({
    workspaceRoot: cwd,
    connect: {
      // A project's own servers connect once the project's settings are trusted (/trust).
      approveServer: async () => settings.projectTrusted(),
      projectPlugins: () => settings.projectTrusted(),
      plugins: opts.settingsConfig?.claudeSettings === true,
    },
  });

  // Enable bracketed paste, and ALWAYS disable it (normal exit, Ctrl-C, or a crash) so we never leave the
  // user's shell in bracketed-paste mode.
  process.stdout.write(PASTE_ON);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.stdout.write(PASTE_OFF);
  };
  process.once("exit", restore);
  // An EXTERNAL signal (kill, terminal close) terminates Node WITHOUT firing `exit`, which would leave the
  // terminal in bracketed-paste mode AND re-deliver the signal before `waitUntilExit().finally` runs —
  // so the MCP servers must be shut down HERE (idempotent), else their child processes leak on a signal exit.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      mcp.close();
      restore();
      // Everything else that cleans up on `exit` (background commands and subagents, the glyph fallback)
      // must run too — a signal exit never fires it.
      process.emit("exit", 128 + (os.constants.signals[sig] ?? 1));
      // Re-raise so the shell sees the real signal; Windows can't signal a process this way (it throws), so
      // exit with the conventional 128 + signal number instead.
      if (process.platform === "win32") process.exit(128 + (os.constants.signals[sig] ?? 1));
      else process.kill(process.pid, sig);
    });
  }

  // Legacy Windows console: draw glyphs as ASCII so nothing renders as empty boxes.
  const restoreGlyphs = needsAsciiFallback() ? installAsciiFallback(process.stdout) : () => {};
  process.once("exit", restoreGlyphs);

  // The session in use (a /clear starts a new one) — for the SessionEnd hook when the TUI closes.
  let currentSession = "";
  const instance = render(
    createElement(App, {
      client,
      makeWriter: (sessionId: string) => {
        currentSession = sessionId;
        return new SessionWriter(sessionId, () => new Date().toISOString());
      },
      settings,
      memory: makeMemoryPort(cwd, ambHome()),
      userInstructions: opts.settingsConfig?.claudeSettings === true,
      capabilities: makeCapabilityPort(),
      agentMode: opts.agentMode,
      permission: opts.permission,
      effort: opts.effort,
      requestedModel: opts.requestedModel,
      maxTurns: opts.maxTurns,
      autoContinue: opts.autoContinue ?? true,
      maxAutoContinues: opts.maxAutoContinues ?? 3,
      version: CURRENT_VERSION,
      ...(update ? { update } : {}),
      cwd,
      workspaceRoot: cwd,
      fleet,
      initialTask: opts.initialTask,
      ...(opts.initialGoal ? { initialGoal: opts.initialGoal } : {}),
      ...(opts.initialGrants && opts.initialGrants.length > 0
        ? { initialGrants: opts.initialGrants }
        : {}),
      getMcpTools: () => mcp.tools(),
      ...(skipMcp ? {} : { mcp }),
      skillsInfo,
      skills: skillRows,
      onTogglePin,
      account,
      listFiles: () => listWorkspaceFiles(cwd),
      history: {
        load: () => loadHistory(historyPath(cwd)),
        append: (text: string) => appendHistory(historyPath(cwd), text),
      },
      refreshFleet: async () => {
        const models = await client.fetchCatalog(undefined, { fresh: true });
        return formatFleetRows(models, laneResolver());
      },
    }),
    { exitOnCtrlC: false },
  );

  // Now that the UI is on screen, connect MCP in the background; runs read the tools live. A failure never
  // breaks the session — the built-in tools always work; MCP just augments them when ready.
  if (!skipMcp) void mcp.start();

  try {
    await instance.waitUntilExit();
  } finally {
    await fireAndForget(
      settings.hooksPort(() => currentSession),
      "SessionEnd",
      { reason: "exit" },
    );
    mcp.close();
    restore();
  }
}
