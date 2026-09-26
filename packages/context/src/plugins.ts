import { homedir } from "node:os";
import { join } from "node:path";
import { isRealDir, readTextCappedSafe } from "./fs-safe.js";

/**
 * Claude Code plugins the user has installed AND enabled, at the version that applies to this workspace.
 * Read from `~/.claude/plugins/installed_plugins.json` (what's installed where) and the `enabledPlugins` maps
 * in `~/.claude/settings.json` plus the project's `.claude/settings.json` / `settings.local.json` (later
 * files override earlier ones). A plugin's folder can hold skills/, commands/, agents/, hooks/ and .mcp.json.
 */
export interface InstalledPlugin {
  /** `name@marketplace` */
  id: string;
  name: string;
  /** Absolute path to the plugin's installed version. */
  root: string;
}

interface InstallEntry {
  scope?: string;
  projectPath?: string;
  installPath?: string;
  lastUpdated?: string;
}

function readJson(file: string, root: string): unknown {
  const text = readTextCappedSafe(file, { root, maxBytes: 4 * 1024 * 1024 });
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface PluginOptions {
  /** Let the project's own settings turn plugins on or off — only once the project is trusted (a clone
   *  mustn't switch on a plugin you left off, or switch off a guard you rely on). Off unless asked for. */
  projectSettings?: boolean;
}

/** The project's own `enabledPlugins` entries (shared, then local) — part of what trusting a project covers. */
export function projectEnabledPlugins(workspaceRoot: string): Record<string, unknown> {
  const dir = join(workspaceRoot, ".claude");
  const out: Record<string, unknown> = {};
  for (const name of ["settings.json", "settings.local.json"]) {
    const data = readJson(join(dir, name), dir) as
      | { enabledPlugins?: Record<string, unknown> }
      | undefined;
    Object.assign(out, data?.enabledPlugins ?? {});
  }
  return out;
}

/** The merged `enabledPlugins` map: user settings, then (unless told not to) the project's shared and local
 *  settings. */
export function enabledPluginIds(
  workspaceRoot: string,
  home: string = homedir(),
  opts: PluginOptions = {},
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const project =
    opts.projectSettings === true && join(workspaceRoot, ".claude") !== join(home, ".claude");
  const files: Array<{ file: string; root: string }> = [
    { file: join(home, ".claude", "settings.json"), root: join(home, ".claude") },
    ...(project
      ? [
          {
            file: join(workspaceRoot, ".claude", "settings.json"),
            root: join(workspaceRoot, ".claude"),
          },
          {
            file: join(workspaceRoot, ".claude", "settings.local.json"),
            root: join(workspaceRoot, ".claude"),
          },
        ]
      : []),
  ];
  for (const { file, root } of files) {
    const data = readJson(file, root) as { enabledPlugins?: Record<string, unknown> } | undefined;
    for (const [id, on] of Object.entries(data?.enabledPlugins ?? {})) out.set(id, on === true);
  }
  return out;
}

/** Installed + enabled plugins that apply here (user-wide installs, or ones installed for this project). */
export function installedPlugins(
  workspaceRoot: string,
  home: string = homedir(),
  opts: PluginOptions = {},
): InstalledPlugin[] {
  const base = join(home, ".claude", "plugins");
  const data = readJson(join(base, "installed_plugins.json"), base) as
    | { plugins?: Record<string, InstallEntry[] | InstallEntry> }
    | undefined;
  if (!data?.plugins) return [];
  const enabled = enabledPluginIds(workspaceRoot, home, opts);
  const out: InstalledPlugin[] = [];
  for (const [id, raw] of Object.entries(data.plugins)) {
    if (enabled.get(id) !== true) continue;
    const entries = (Array.isArray(raw) ? raw : [raw]).filter(
      (e) =>
        typeof e?.installPath === "string" &&
        (e.scope === "user" || e.scope === undefined || e.projectPath === workspaceRoot),
    );
    // The most recently updated install that applies (a project-specific install, then the user-wide one).
    const pick = entries
      .slice()
      .sort(
        (a, b) =>
          Number(b.projectPath === workspaceRoot) - Number(a.projectPath === workspaceRoot) ||
          String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")),
      )[0];
    if (!pick?.installPath || !isRealDir(pick.installPath)) continue;
    out.push({ id, name: id.split("@")[0] ?? id, root: pick.installPath });
  }
  return out;
}
