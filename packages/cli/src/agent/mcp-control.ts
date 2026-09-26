import { loadMcpConfig } from "@amb/context";
import type { ToolDefinition } from "@amb/protocol";
import { openBrowser } from "../commands/login.js";
import { makeMcpAuth, realFetch } from "../mcp-auth/auth-port.js";
import { signIn } from "../mcp-auth/oauth.js";
import { type TokenStore, makeTokenStore } from "../mcp-auth/token-store.js";
import {
  type ConnectOptions,
  type McpConnection,
  type McpServerStatus,
  connectMcp,
} from "./mcp-connect.js";

/** The session's MCP servers as the TUI sees them: live status, sign-in, and a reconnect after it. */
export interface McpControl {
  /** Each configured server and where it stands; undefined while the first connect is still running. */
  status(): McpServerStatus[] | undefined;
  /** Sign in to a server that uses OAuth, then reconnect so its tools arrive; resolves to what happened. */
  login(name: string, onUrl: (url: string) => void): Promise<string>;
  /** The tools connected right now. */
  tools(): ToolDefinition[];
  /** Prompts the servers offer, as slash commands (`/mcp__server__prompt`). */
  promptCommands(): McpPromptCommand[];
  /** A prompt's text with its arguments filled in from what the user typed after the command. */
  expandPrompt(command: string, args: string): Promise<string>;
  /** Disconnect every server now, then reconnect from the current config and trust (servers no longer
   *  allowed stay off). Rejects when reconnecting fails — the servers are then off until it succeeds. */
  refresh(): Promise<void>;
  close(): void;
}

export interface McpPromptCommand {
  /** `/mcp__server__prompt` */
  name: string;
  desc: string;
  args?: string;
}

const promptCommandName = (server: string, prompt: string) => `/mcp__${server}__${prompt}`;

/** Split typed arguments on spaces, keeping "quoted phrases" together. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export function makeMcpControl(opts: {
  workspaceRoot: string;
  connect: Omit<ConnectOptions, "auth">;
  store?: TokenStore;
  connectImpl?: typeof connectMcp;
  signInImpl?: typeof signIn;
  /** Whether the folder's own settings are trusted right now. When that stops being true (its settings
   *  changed, or /trust no), the servers it brought are dropped at once and the rest reconnect. */
  projectTrusted?: () => boolean;
}): McpControl & { start(): Promise<void> } {
  const store = opts.store ?? makeTokenStore();
  const connect = opts.connectImpl ?? connectMcp;
  let current: McpConnection | undefined;
  let closed = false;
  // Each connect gets a number; only the newest may take over, so a slow first connect finishing after a
  // sign-in's reconnect can't put the old, signed-out connection back.
  let generation = 0;

  const reconnect = async () => {
    const mine = ++generation;
    const next = await connect(opts.workspaceRoot, { ...opts.connect, auth: makeMcpAuth(store) });
    if (closed || mine !== generation) {
      next.close(); // superseded, or the session ended while connecting — don't leak the servers
      return;
    }
    current?.close();
    current = next;
  };

  // Drop the current servers at once (nothing revoked stays usable while the new connection starts, or if
  // it fails), then connect again from the current config and trust. Rejects if that fails.
  // Checked whenever tools or prompts are handed out: trust that lapsed takes the folder's servers with it.
  let trustedBefore = opts.projectTrusted?.() ?? true;
  const refresh = async () => {
    trustedBefore = opts.projectTrusted?.() ?? true; // this reconnect already reflects the trust as it is
    generation++; // a connect still in flight must not put the old servers back
    current?.close();
    current = undefined;
    await reconnect();
  };
  const followTrust = () => {
    if (!opts.projectTrusted) return;
    const now = opts.projectTrusted();
    const lapsed = trustedBefore && !now;
    trustedBefore = now;
    // Every lapse reconnects: that also discards a connection still being made under the old trust.
    if (lapsed) void refresh().catch(() => {});
  };

  return {
    start: () => reconnect().catch(() => {}),
    refresh,
    status: () => current?.servers,
    tools: () => {
      followTrust();
      return current?.currentTools() ?? [];
    },
    promptCommands: () => {
      followTrust();
      return (current?.prompts ?? [])
        .filter((p) => /^[\w.-]+$/.test(p.prompt.name))
        .map((p) => ({
          name: promptCommandName(p.server, p.prompt.name),
          desc: `${p.prompt.description?.replace(/\s+/g, " ").slice(0, 80) ?? "MCP prompt"} (${p.server})`,
          ...(p.prompt.arguments?.length
            ? {
                args: p.prompt.arguments
                  .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
                  .join(" "),
              }
            : {}),
        }));
    },
    async expandPrompt(command, text) {
      followTrust();
      const entry = current?.prompts.find(
        (p) => promptCommandName(p.server, p.prompt.name) === command,
      );
      if (!entry || !current) throw new Error(`${command} isn't available right now`);
      const words = splitArgs(text);
      const declared = entry.prompt.arguments ?? [];
      const args: Record<string, string> = {};
      declared.forEach((a, i) => {
        // The last declared argument takes the rest of what was typed.
        const value = i === declared.length - 1 ? words.slice(i).join(" ") : words[i];
        if (value) args[a.name] = value;
      });
      const missing = declared.filter((a) => a.required && !args[a.name]).map((a) => a.name);
      if (missing.length > 0) throw new Error(`${command} needs ${missing.join(", ")}`);
      return current.getPrompt(entry.server, entry.prompt.name, args);
    },
    close() {
      closed = true;
      current?.close();
    },
    async login(name, onUrl) {
      const projectPlugins = opts.connect.projectPlugins;
      const spec = loadMcpConfig(opts.workspaceRoot, process.env, undefined, {
        plugins: opts.connect.plugins === true,
        projectPlugins:
          typeof projectPlugins === "function" ? projectPlugins() : projectPlugins === true,
      }).find((s) => s.name === name);
      if (!spec) return `No MCP server named "${name}". /mcp lists them.`;
      if (!spec.url) return `${name} runs on this machine and has no sign-in.`;
      if (spec.source === "project" && !(await opts.connect.approveServer?.(spec))) {
        return `${name} is this project's server — review and trust the project first (/trust).`;
      }
      try {
        await (opts.signInImpl ?? signIn)(spec.url, {
          fetch: realFetch,
          store,
          openBrowser,
          onUrl,
        });
      } catch (e) {
        return `Couldn't sign in to ${name}: ${(e as Error).message}`;
      }
      await reconnect().catch(() => {});
      const now = current?.servers.find((s) => s.name === name);
      return now?.state === "connected"
        ? `Signed in to ${name} · ${now.tools} tool${now.tools === 1 ? "" : "s"} ready.`
        : `Signed in to ${name}, but it didn't connect${now?.detail ? `: ${now.detail}` : ""}.`;
    },
  };
}

const STATE_LABEL: Record<McpServerStatus["state"], string> = {
  connected: "connected",
  "needs-sign-in": "needs sign-in",
  failed: "failed",
  skipped: "not started",
};

/** What `/mcp` shows. */
export function mcpReport(servers: McpServerStatus[] | undefined): string {
  if (servers === undefined) return "MCP servers are still connecting…";
  if (servers.length === 0) return "No MCP servers configured.";
  const w = Math.min(28, Math.max(...servers.map((s) => s.name.length)));
  const lines = servers.map((s) => {
    const what =
      s.state === "connected"
        ? `connected · ${s.tools} tool${s.tools === 1 ? "" : "s"}`
        : `${STATE_LABEL[s.state]}${s.detail ? ` · ${s.detail}` : ""}`;
    return `  ${s.name.padEnd(w)}  ${what}`;
  });
  const signIn = servers.filter((s) => s.state === "needs-sign-in").map((s) => s.name);
  return [
    `MCP servers (${servers.filter((s) => s.state === "connected").length} of ${servers.length} connected):`,
    ...lines,
    ...(signIn.length > 0 ? ["", `Sign in with /mcp login ${signIn[0]}`] : []),
  ].join("\n");
}
