import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readTextCappedSafe } from "./fs-safe.js";
import { installedPlugins } from "./plugins.js";

/**
 * A normalized MCP server spec — the single shape both the Claude `.mcp.json` dialect and the Codex
 * `config.toml [mcp_servers]` dialect reduce to, so a user's EXISTING setup (from either ecosystem) works on
 * Ambient models with no reconfiguration. Best-effort: a missing/malformed source contributes nothing.
 */
export interface McpServerSpec {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** HTTP headers for a remote server (auth tokens), with `${VAR}`s already filled in. */
  headers?: Record<string, string>;
  /** Environment variables the entry refers to that aren't set — the server can't work until they are. */
  missingEnv?: string[];
  /** The entry exactly as written (before `${VAR}` expansion) — what trusting a project server covers. */
  raw?: unknown;
  /** project = a workspace file (higher trust surface — the CLI gates these before spawning); plugin = an
   *  enabled Claude Code plugin's `.mcp.json`. */
  source: McpSource;
}

export type McpSource = "project" | "user" | "plugin";

/** Expand `${VAR}` (and `${VAR:-default}`) from the environment inside a string (leaves an unset var as-is). */
function expand(s: string, env: Record<string, string | undefined>): string {
  return s.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (whole, k: string, dflt: string | undefined) => env[k] ?? dflt ?? whole,
  );
}

/** The `${VAR}` references still unexpanded in a spec (unset variables). */
function unsetVars(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values)
    for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1] as string);
  return [...out];
}

/** Headers for a remote entry: Claude's `headers`, and Codex's `http_headers`, `env_http_headers` (header →
 *  variable name) and `bearer_token_env_var`. */
function remoteHeaders(
  r: Record<string, unknown>,
  env: Record<string, string | undefined>,
): { headers?: Record<string, string>; missing: string[] } {
  const headers: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of ["headers", "http_headers"]) {
    const h = r[key];
    if (h && typeof h === "object") {
      for (const [k, v] of Object.entries(h))
        if (typeof v === "string") headers[k] = expand(v, env);
    }
  }
  const fromEnv = r.env_http_headers;
  if (fromEnv && typeof fromEnv === "object") {
    for (const [k, v] of Object.entries(fromEnv)) {
      if (typeof v !== "string") continue;
      const value = env[v];
      if (value) headers[k] = value;
      else missing.push(v);
    }
  }
  if (typeof r.bearer_token_env_var === "string") {
    const token = env[r.bearer_token_env_var];
    if (token) headers.Authorization = `Bearer ${token}`;
    else missing.push(r.bearer_token_env_var);
  }
  return { ...(Object.keys(headers).length > 0 ? { headers } : {}), missing };
}
function expandArgs(args: unknown, env: Record<string, string | undefined>): string[] | undefined {
  if (!Array.isArray(args)) return undefined;
  return args.filter((a): a is string => typeof a === "string").map((a) => expand(a, env));
}
function expandEnv(
  obj: unknown,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[k] = expand(v, env);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalize one raw server entry (either dialect) into a spec, or null if unusable. */
function toSpec(
  name: string,
  raw: unknown,
  source: McpSource,
  env: Record<string, string | undefined>,
): McpServerSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.enabled === false) return null;
  const url = typeof r.url === "string" ? expand(r.url, env) : undefined;
  const declared = typeof r.type === "string" ? r.type : undefined;
  const transport: McpServerSpec["transport"] =
    declared === "sse" ? "sse" : declared === "http" || url ? "http" : "stdio";
  if (transport === "stdio") {
    if (typeof r.command !== "string") return null;
    const command = expand(r.command, env);
    const args = expandArgs(r.args, env);
    const childEnv = expandEnv(r.env, env);
    const missing = unsetVars([command, ...(args ?? []), ...Object.values(childEnv ?? {})]);
    return {
      name,
      transport: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(childEnv ? { env: childEnv } : {}),
      ...(missing.length > 0 ? { missingEnv: missing } : {}),
      source,
    };
  }
  if (!url) return null;
  const { headers, missing } = remoteHeaders(r, env);
  const unset = [...new Set([...missing, ...unsetVars([url, ...Object.values(headers ?? {})])])];
  return {
    name,
    transport,
    url,
    ...(headers ? { headers } : {}),
    ...(unset.length > 0 ? { missingEnv: unset } : {}),
    source,
  };
}

/** A value shaped like a single server entry — it must carry a usable `command` or `url`. */
function looksLikeServerEntry(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.command === "string" || typeof o.url === "string";
}

/**
 * True when `mcpServers` is a WRAPPER (a map of named servers) rather than one server literally named
 * `mcpServers` in a bare file. The disambiguation is by the GRANDCHILDREN: a wrapper's values are themselves
 * server-entry objects; a bare server's values are its own fields (strings/booleans/arrays). This correctly
 * handles a wrapped config whose server is named `env`/`enabled`/… (values ARE server entries ⇒ wrapper) AND
 * a bare disabled `{mcpServers:{enabled:false}}` (value `false` is NOT a server entry ⇒ bare).
 */
function isWrapperMap(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const values = Object.values(v as Record<string, unknown>);
  return values.length > 0 && values.every(looksLikeServerEntry);
}

/** `~/.claude.json` also holds Claude Code's per-project history, so it grows well past a config file's size. */
const CLAUDE_JSON_MAX_BYTES = 32 * 1024 * 1024;

/** Read a Claude-style `.mcp.json` — accepts BOTH the wrapped `{mcpServers:{…}}` and the bare `{…}` shape. */
function readJsonServers(path: string, root: string): Record<string, unknown> {
  const big = path.endsWith(".claude.json") ? { maxBytes: CLAUDE_JSON_MAX_BYTES } : {};
  const text = readTextCappedSafe(path, { root, ...big }); // size-bounded + symlink-safe (leaf + ancestor)
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // Treat `mcpServers` as the wrapper ONLY when its VALUES are server entries — not when it is itself one
    // server named "mcpServers" in a bare file (which would otherwise swallow that entry + all its siblings).
    if (isWrapperMap(parsed.mcpServers)) return parsed.mcpServers as Record<string, unknown>;
    return parsed;
  } catch {
    return {};
  }
}

/** Read a Codex `config.toml`'s `[mcp_servers]` table. */
function readTomlServers(path: string, root: string): Record<string, unknown> {
  const text = readTextCappedSafe(path, { root }); // size-bounded + symlink-safe (leaf + ancestor)
  if (text === null) return {};
  try {
    const parsed = parseToml(text) as Record<string, unknown>;
    const t = parsed.mcp_servers;
    return t && typeof t === "object" ? (t as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The servers `claude mcp add` saved for this one project (local scope) inside `~/.claude.json`. */
function readClaudeProjectServers(workspaceRoot: string) {
  return (path: string, root: string): Record<string, unknown> => {
    const text = readTextCappedSafe(path, { root, maxBytes: CLAUDE_JSON_MAX_BYTES });
    if (text === null) return {};
    try {
      const parsed = JSON.parse(text) as { projects?: Record<string, { mcpServers?: unknown }> };
      const servers = parsed.projects?.[workspaceRoot]?.mcpServers;
      return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
}

/** Plugin server names are namespaced like Claude Code's: `plugin_<plugin>_<server>`. */
function pluginServerName(plugin: string, server: string): string {
  return `plugin_${plugin}_${server}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export interface McpConfigOptions {
  /** Include the servers of enabled Claude Code plugins. */
  plugins?: boolean;
  /** Whether the project's own settings may turn plugins on or off (only once it's trusted). */
  projectPlugins?: boolean;
}

/**
 * Load MCP server specs from all supported locations. Precedence (a name seen first WINS): this project's
 * entry in `~/.claude.json` (Claude's local scope) → project `.mcp.json` → project `.ambient/mcp.json` →
 * `~/.claude.json` (mcpServers) → `~/.codex/config.toml` → enabled plugins (when asked).
 */
export function loadMcpConfig(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  opts: McpConfigOptions = {},
): McpServerSpec[] {
  const sources: {
    path: string;
    read: (p: string, root: string) => Record<string, unknown>;
    source: McpSource;
    /** Containment root the config file's real parent must stay under (symlinked-ancestor guard). */
    root: string;
    /** Filled in for `${CLAUDE_PLUGIN_ROOT}`, and the prefix of the server names. */
    plugin?: { name: string; root: string };
  }[] = [
    {
      path: join(home, ".claude.json"),
      read: readClaudeProjectServers(workspaceRoot),
      source: "user",
      root: home,
    },
    {
      path: join(workspaceRoot, ".mcp.json"),
      read: readJsonServers,
      source: "project",
      root: workspaceRoot,
    },
    {
      path: join(workspaceRoot, ".ambient", "mcp.json"),
      read: readJsonServers,
      source: "project",
      root: workspaceRoot,
    },
    { path: join(home, ".claude.json"), read: readJsonServers, source: "user", root: home },
    {
      path: join(home, ".codex", "config.toml"),
      read: readTomlServers,
      source: "user",
      root: home,
    },
    ...(opts.plugins
      ? installedPlugins(workspaceRoot, home, {
          projectSettings: opts.projectPlugins === true,
        }).map((p) => ({
          path: join(p.root, ".mcp.json"),
          read: readJsonServers,
          source: "plugin" as const,
          root: p.root,
          plugin: { name: p.name, root: p.root },
        }))
      : []),
  ];
  const byName = new Map<string, McpServerSpec>();
  const claimed = new Set<string>(); // names RESERVED by a higher-precedence file (even if disabled/malformed)
  for (const src of sources) {
    const srcEnv = src.plugin ? { ...env, CLAUDE_PLUGIN_ROOT: src.plugin.root } : env;
    for (const [rawName, raw] of Object.entries(src.read(src.path, src.root))) {
      const name = src.plugin ? pluginServerName(src.plugin.name, rawName) : rawName;
      if (claimed.has(name) || !/^[a-zA-Z0-9_.-]+$/.test(name)) continue; // first-wins + safe names only
      if (!raw || typeof raw !== "object") continue; // scalar junk doesn't reserve a name for a lower file
      // A deliberate higher-precedence declaration claims the name even when disabled: a project
      // `docs:{enabled:false}` must suppress a lower-precedence global `docs` server.
      claimed.add(name);
      const spec = toSpec(name, raw, src.source, srcEnv);
      if (spec) byName.set(name, { ...spec, raw });
    }
  }
  return [...byName.values()];
}

/**
 * Servers from a `--mcp-config` value: inline JSON, or a path to a `.mcp.json`-style file (wrapped or bare).
 * They're the user's own for this run. Throws with a readable message when the value can't be used.
 */
export function mcpServersFromFlag(
  value: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): McpServerSpec[] {
  let text = value.trim();
  if (!text.startsWith("{")) {
    const path = isAbsolute(text) ? text : join(cwd, text);
    const read = readTextCappedSafe(path, { root: dirname(path) });
    if (read === null) throw new Error(`can't read MCP config ${value}`);
    text = read;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`MCP config ${value.length > 60 ? "value" : value} isn't valid JSON`);
  }
  const servers = isWrapperMap(parsed.mcpServers)
    ? (parsed.mcpServers as Record<string, unknown>)
    : parsed;
  const out: McpServerSpec[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
    const spec = toSpec(name, raw, "user", env);
    if (spec) out.push(spec);
  }
  return out;
}
