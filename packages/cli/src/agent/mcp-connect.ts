import { type McpServerSpec, loadMcpConfig } from "@amb/context";
import { McpHttpError, type McpPromptEntry, startMcpServers } from "@amb/mcp";
import type { ToolDefinition } from "@amb/protocol";
import { tokenSafeUrl } from "../mcp-auth/oauth.js";

/** Where a configured server stands after connecting. */
export interface McpServerStatus {
  name: string;
  source: McpServerSpec["source"];
  transport: McpServerSpec["transport"];
  state: "connected" | "needs-sign-in" | "failed" | "skipped";
  tools: number;
  detail?: string;
}

export interface McpConnection {
  tools: ToolDefinition[];
  /** The tools as they are now (servers can announce a changed list). */
  currentTools: () => ToolDefinition[];
  close: () => void;
  notices: string[];
  servers: McpServerStatus[];
  prompts: McpPromptEntry[];
  getPrompt: (server: string, name: string, args: Record<string, string>) => Promise<string>;
}

const NOTHING = {
  tools: [] as ToolDefinition[],
  currentTools: () => [] as ToolDefinition[],
  close: () => {},
  prompts: [] as McpPromptEntry[],
  getPrompt: () => Promise.reject(new Error("no MCP servers are connected")),
};

/** Sign-in for remote servers: a stored access token to send, and a refreshed one after a 401. */
export interface McpAuthPort {
  token(url: string): Promise<string | undefined>;
  refresh(url: string): Promise<string | undefined>;
}

export interface ConnectOptions {
  approveServer?: (s: McpServerSpec) => Promise<boolean>;
  /** Also connect enabled Claude Code plugins' servers (config `claudeSettings`). */
  plugins?: boolean;
  /** Let the project's own settings turn plugins on or off (once it's trusted) — checked when connecting. */
  projectPlugins?: boolean | (() => boolean);
  /** Stored sign-ins for servers that use OAuth. */
  auth?: McpAuthPort;
  /** Servers given for this run (`--mcp-config`); they win over configured servers with the same name. */
  extra?: McpServerSpec[];
  /** Use only `extra` (`--strict-mcp-config`). */
  strict?: boolean;
  /** Test seams — default to the real config loader + server starter. */
  load?: () => McpServerSpec[];
  start?: typeof startMcpServers;
}

/**
 * Connect the user's configured MCP servers (Claude `.mcp.json` + `~/.claude.json`, Codex `config.toml`,
 * project `.ambient/mcp.json`, and optionally enabled plugins) over stdio, Streamable HTTP or legacy SSE, and
 * return their tools for the registry. A PROJECT-scoped server is a process-spawn/secret surface, so it only
 * starts when `approveServer` says yes; the user's own servers start automatically. A server that fails to
 * start is skipped, never fatal.
 */
export async function connectMcp(
  workspaceRoot: string,
  opts: ConnectOptions = {},
): Promise<McpConnection> {
  const configured = opts.strict
    ? []
    : opts.load
      ? opts.load()
      : loadMcpConfig(workspaceRoot, process.env, undefined, {
          plugins: opts.plugins === true,
          projectPlugins:
            typeof opts.projectPlugins === "function"
              ? opts.projectPlugins()
              : opts.projectPlugins === true,
        });
  const extra = opts.extra ?? [];
  const specs = [...extra, ...configured.filter((c) => !extra.some((e) => e.name === c.name))];
  if (specs.length === 0) return { ...NOTHING, notices: [], servers: [] };

  const notices: string[] = [];
  const usable: McpServerSpec[] = [];
  const statuses = new Map<string, McpServerStatus>();
  const status = (s: McpServerSpec, state: McpServerStatus["state"], detail?: string) =>
    statuses.set(s.name, { ...baseStatus(s), state, tools: 0, ...(detail ? { detail } : {}) });
  for (const s of specs) {
    // stdio (a local process), Streamable HTTP and legacy SSE are supported; an unknown transport is skipped.
    if (s.transport !== "stdio" && s.transport !== "http" && s.transport !== "sse") {
      notices.push(`mcp: ${s.name} uses ${s.transport} — transport not supported (skipped)`);
      status(s, "skipped", "transport not supported");
      continue;
    }
    if ((s.transport === "http" || s.transport === "sse") && !s.url) {
      notices.push(`mcp: ${s.name} is remote but has no url (skipped)`);
      status(s, "skipped", "no url");
      continue;
    }
    if (s.missingEnv && s.missingEnv.length > 0) {
      notices.push(
        `mcp: ${s.name} needs ${s.missingEnv.join(", ")} set in your environment (skipped)`,
      );
      status(s, "skipped", `needs ${s.missingEnv.join(", ")}`);
      continue;
    }
    // A PROJECT-scoped server (a workspace file, higher trust surface — a local process OR remote data egress)
    // starts only with an explicit approval. Fail CLOSED: no approver ⇒ not approved.
    if (s.source === "project" && !(opts.approveServer && (await opts.approveServer(s)))) {
      notices.push(
        `mcp: ${s.name} is this project's server; it starts once you trust the project (ambient trust)`,
      );
      status(s, "skipped", "project not trusted yet (/trust)");
      continue;
    }
    usable.push(s);
  }
  const ordered = (): McpServerStatus[] =>
    specs.map((s) => statuses.get(s.name)).filter((x): x is McpServerStatus => x !== undefined);
  if (usable.length === 0) return { ...NOTHING, notices, servers: ordered() };

  const auth = opts.auth;
  const configs = await Promise.all(
    usable.map(async (s) => {
      if (s.transport === "stdio") {
        return {
          name: s.name,
          config: {
            command: s.command as string,
            ...(s.args ? { args: s.args } : {}),
            ...(s.env ? { env: s.env } : {}),
          },
        };
      }
      const url = s.url as string;
      // A server you've signed in to gets its token, unless the config already sends its own credentials.
      const hasAuth = Object.keys(s.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
      // Tokens only ever travel over https (or to this machine).
      const canAuth = !hasAuth && auth !== undefined && tokenSafeUrl(url);
      const token = canAuth ? await auth.token(url) : undefined;
      const headers = { ...s.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      return {
        name: s.name,
        config: {
          url,
          ...(s.transport === "sse" ? { legacySse: true } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(canAuth ? { reauthorize: () => auth.refresh(url) } : {}),
        },
      };
    }),
  );

  const start = opts.start ?? startMcpServers;
  const session = await start(configs, {
    onLog: (m) => {
      // A server that wants a sign-in gets its own, actionable notice (below) instead of the raw failure.
      if (!/needs you to sign in/.test(m)) notices.push(m);
    },
  });
  const specByName = new Map(usable.map((s) => [s.name, s]));
  for (const out of session.servers ?? []) {
    const spec = specByName.get(out.name);
    if (!spec) continue;
    if (out.ok) {
      statuses.set(out.name, { ...baseStatus(spec), state: "connected", tools: out.tools });
    } else if (out.error instanceof McpHttpError && out.error.status === 401) {
      notices.push(`mcp: ${out.name} needs you to sign in — ambient mcp login ${out.name}`);
      statuses.set(out.name, { ...baseStatus(spec), state: "needs-sign-in", tools: 0 });
    } else {
      statuses.set(out.name, {
        ...baseStatus(spec),
        state: "failed",
        tools: 0,
        ...(out.error ? { detail: out.error.message } : {}),
      });
    }
  }
  return {
    tools: session.tools,
    currentTools: session.currentTools ?? (() => session.tools),
    close: session.close,
    notices,
    servers: ordered(),
    prompts: session.prompts ?? [],
    getPrompt: session.getPrompt ?? NOTHING.getPrompt,
  };
}

function baseStatus(s: McpServerSpec): Omit<McpServerStatus, "state" | "tools"> {
  return { name: s.name, source: s.source, transport: s.transport };
}
