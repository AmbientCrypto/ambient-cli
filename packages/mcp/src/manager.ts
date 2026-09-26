import type { ToolDefinition } from "@amb/protocol";
import { McpClient, type McpPrompt, type McpTool } from "./client.js";
import { type HttpServerConfig, spawnHttpTransport } from "./http.js";
import { JsonRpcClient, type Transport } from "./jsonrpc.js";
import { spawnSseTransport } from "./sse-legacy.js";
import { type StdioServerConfig, spawnStdioTransport } from "./stdio.js";
import { mcpResourceTools, mcpToolToDefinition } from "./to-tool.js";

/** One MCP server: either a local stdio child process OR a remote Streamable-HTTP endpoint. */
export type McpServerConfig = StdioServerConfig | HttpServerConfig;
export interface McpServerSpec {
  name: string;
  config: McpServerConfig;
}

/** The default transport factory — picks HTTP for a `{url}` config, else spawns a stdio child. */
function defaultSpawn(cfg: McpServerConfig): { transport: Transport } {
  if (!("url" in cfg)) return spawnStdioTransport(cfg);
  return cfg.legacySse ? spawnSseTransport(cfg) : spawnHttpTransport(cfg);
}

/** How one server's start went. */
export interface McpServerOutcome {
  name: string;
  ok: boolean;
  /** Tools it contributed (0 when it failed). */
  tools: number;
  /** Why it failed. */
  error?: Error;
}

/** A prompt a server offers, usable as a slash command. */
export interface McpPromptEntry {
  server: string;
  prompt: McpPrompt;
}

export interface McpSession {
  /** All discovered tools across servers at start, as ambient ToolDefinitions (register these). */
  tools: ToolDefinition[];
  /** The tools as they are now — a server that announces a changed tool list is re-read. */
  currentTools(): ToolDefinition[];
  /** Per-server results, in config order. */
  servers: McpServerOutcome[];
  /** Prompts the servers offer. */
  prompts: McpPromptEntry[];
  /** A prompt's text with its arguments filled in. */
  getPrompt(server: string, name: string, args: Record<string, string>): Promise<string>;
  /** Shut every server down (kills the child processes). */
  close(): void;
}

export interface StartOptions {
  onLog?: (msg: string) => void;
  /** Timeout for the handshake + tools/list (quick). A tool CALL uses `callTimeoutMs` instead. */
  initTimeoutMs?: number;
  /** Timeout for a single tools/call — much longer than init so a legitimately slow tool isn't cut short. */
  callTimeoutMs?: number;
  /** Injectable transport factory (defaults to stdio child / HTTP by config shape) — tests pass a fake. */
  spawn?: (cfg: McpServerConfig) => { transport: Transport };
}

/**
 * Start a set of MCP servers, run the handshake, discover their tools, and return them as ambient tools plus
 * a `close()`. A server that fails to start / initialize / list is LOGGED and SKIPPED — one bad server never
 * kills the run (or the others). Every discovered tool is namespaced + untrusted-guarded by mcpToolToDefinition.
 */
export async function startMcpServers(
  specs: McpServerSpec[],
  opts: StartOptions = {},
): Promise<McpSession> {
  const log = opts.onLog ?? (() => {});
  const spawnFn = opts.spawn ?? defaultSpawn;

  // Servers start in PARALLEL (one slow or dead server must not hold up the rest); their tools are then
  // registered in config order, so the tool list — and the prompt it feeds — is the same every time.
  const started = await Promise.all(
    specs.map(async (spec) => {
      let client: McpClient | undefined;
      try {
        const { transport } = spawnFn(spec.config);
        client = new McpClient(
          new JsonRpcClient(transport, { requestTimeoutMs: opts.initTimeoutMs ?? 15_000 }),
          { ...(opts.callTimeoutMs ? { callTimeoutMs: opts.callTimeoutMs } : {}) },
        );
        await client.initialize();
        return { ok: true as const, spec, client, discovered: await client.listTools() };
      } catch (e) {
        // The server spawned but failed to initialize/list — close it so we don't leak the child process.
        try {
          client?.close();
        } catch {
          /* already gone */
        }
        log(`mcp: ${spec.name} unavailable — skipped (${(e as Error).message})`);
        return { ok: false as const, spec, error: e as Error };
      }
    }),
  );

  const clients = new Map<string, McpClient>();
  const servers: McpServerOutcome[] = [];
  // Each server's tools, in config order; rebuilt for a server when it announces a changed list.
  const byServer = new Map<string, ToolDefinition[]>();
  const order: string[] = [];
  const build = (server: string, client: McpClient, discovered: McpTool[]) =>
    discovered
      .map((t) => mcpToolToDefinition(server, t, client))
      .filter((d): d is ToolDefinition => d !== null);

  for (const s of started) {
    if (!s.ok) {
      servers.push({ name: s.spec.name, ok: false, tools: 0, error: s.error });
      continue;
    }
    const defs = build(s.spec.name, s.client, s.discovered);
    clients.set(s.spec.name, s.client);
    byServer.set(s.spec.name, defs);
    order.push(s.spec.name);
    const server = s.spec.name;
    const client = s.client;
    // Rapid change notices can race: only the newest listing may land (an older reply arriving late
    // would otherwise put back a stale tool list).
    let generation = 0;
    client.onToolsChanged(() => {
      const mine = ++generation;
      void client
        .listTools()
        .then((next) => {
          if (mine !== generation) return;
          byServer.set(server, build(server, client, next));
          log(`mcp: ${server} updated its tools`);
        })
        .catch(() => {});
    });
  }

  // Two tools that collapse to the same id (a same-server duplicate, or a server/tool name pair that aliases
  // another) must NOT reach the registry — register() throws on a dup and would abort the run.
  const assemble = (quiet: boolean): ToolDefinition[] => {
    const seen = new Set<string>();
    const out: ToolDefinition[] = [];
    for (const server of order) {
      for (const def of byServer.get(server) ?? []) {
        if (seen.has(def.manifest.name)) {
          if (!quiet)
            log(`mcp: ${server} tool ${def.manifest.name} duplicates an existing tool — skipped`);
          continue;
        }
        seen.add(def.manifest.name);
        out.push(def);
      }
    }
    const withResources = order.filter((n) => clients.get(n)?.capabilities.resources);
    if (withResources.length > 0) {
      out.push(
        ...mcpResourceTools(
          new Map(withResources.map((n) => [n, clients.get(n) as McpClient])),
        ).filter((d) => !seen.has(d.manifest.name)),
      );
    }
    return out;
  };
  const tools = assemble(false);
  for (const server of order) {
    const n = tools.filter((t) => t.manifest.name.startsWith(`mcp__${server}__`)).length;
    servers.push({ name: server, ok: true, tools: n });
    log(`mcp: ${server} → ${n} tool(s)`);
  }
  // Keep config order in the outcomes (failures were pushed as they were found).
  servers.sort(
    (a, b) => specs.findIndex((x) => x.name === a.name) - specs.findIndex((x) => x.name === b.name),
  );

  const prompts: McpPromptEntry[] = [];
  await Promise.all(
    order.map(async (server) => {
      const client = clients.get(server);
      if (!client?.capabilities.prompts) return;
      try {
        for (const prompt of await client.listPrompts()) prompts.push({ server, prompt });
      } catch {
        // a server whose prompt list fails still serves its tools
      }
    }),
  );
  prompts.sort(
    (a, b) =>
      order.indexOf(a.server) - order.indexOf(b.server) ||
      a.prompt.name.localeCompare(b.prompt.name),
  );

  return {
    tools,
    currentTools: () => assemble(true),
    servers,
    prompts,
    getPrompt: async (server, name, args) => {
      const client = clients.get(server);
      if (!client) throw new Error(`no MCP server named ${server}`);
      return client.getPrompt(name, args);
    },
    close: () => {
      for (const c of clients.values()) {
        try {
          c.close();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
