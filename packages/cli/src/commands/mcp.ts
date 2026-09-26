import { loadMcpConfig } from "@amb/context";
import { workspaceSettings } from "../agent/workspace-settings.js";
import { configDir, loadConfig } from "../config.js";
import { realFetch } from "../mcp-auth/auth-port.js";
import { signIn } from "../mcp-auth/oauth.js";
import { makeTokenStore } from "../mcp-auth/token-store.js";
import { openBrowser } from "./login.js";

const SOURCE_LABEL = { user: "yours", project: "this project", plugin: "a plugin" } as const;

/**
 * `ambient mcp` lists the configured MCP servers; `ambient mcp login <name>` signs in to a server that uses
 * OAuth (opens the browser); `ambient mcp logout <name>` forgets that sign-in.
 */
export async function runMcp(args: string[]): Promise<void> {
  const config = loadConfig();
  const cwd = process.cwd();
  const trustedHere = workspaceSettings(cwd, config, configDir()).projectTrusted();
  const specs = loadMcpConfig(cwd, process.env, undefined, {
    plugins: config.claudeSettings === true,
    projectPlugins: trustedHere,
  });
  const store = makeTokenStore();
  const [sub, name] = args;

  if (sub === undefined || sub === "list") {
    if (specs.length === 0) {
      process.stdout.write("No MCP servers configured.\n");
      return;
    }
    const trusted = workspaceSettings(cwd, config, configDir()).projectTrusted();
    for (const s of specs) {
      const where = s.command ? [s.command, ...(s.args ?? [])].join(" ") : (s.url ?? "");
      const notes = [
        SOURCE_LABEL[s.source],
        s.transport,
        ...(s.url && store.get(s.url)?.tokens ? ["signed in"] : []),
        ...(s.missingEnv?.length ? [`needs ${s.missingEnv.join(", ")}`] : []),
        ...(s.source === "project" && !trusted ? ["waits for ambient trust"] : []),
      ];
      const shown = where.length > 60 ? `${where.slice(0, 59)}…` : where;
      process.stdout.write(`${s.name.padEnd(24)} ${shown}\n${"".padEnd(25)}${notes.join(" · ")}\n`);
    }
    return;
  }

  if (sub === "login" || sub === "logout") {
    if (!name) {
      process.stderr.write(`ambient: which server? (use: ambient mcp ${sub} <name>)\n`);
      process.exitCode = 1;
      return;
    }
    const spec = specs.find((s) => s.name === name);
    if (!spec) {
      process.stderr.write(`ambient: no MCP server named "${name}" (see: ambient mcp)\n`);
      process.exitCode = 1;
      return;
    }
    if (!spec.url) {
      process.stderr.write(`ambient: ${name} runs on this machine and has no sign-in\n`);
      process.exitCode = 1;
      return;
    }
    if (
      sub === "login" &&
      spec.source === "project" &&
      !workspaceSettings(cwd, config, configDir()).projectTrusted()
    ) {
      process.stderr.write(
        `ambient: ${name} is this project's server — review and trust the project first (ambient trust)\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (sub === "logout") {
      if (!store.get(spec.url)) {
        process.stdout.write(`You weren't signed in to ${name}.\n`);
        return;
      }
      store.delete(spec.url);
      process.stdout.write(`Signed out of ${name}.\n`);
      return;
    }
    process.stdout.write(`Opening your browser to sign in to ${name}…\n`);
    try {
      await signIn(spec.url, {
        fetch: realFetch,
        store,
        openBrowser,
        onUrl: (url) => process.stdout.write(`If it didn't open, visit:\n  ${url}\n`),
      });
      process.stdout.write(
        `Signed in to ${name}. Its tools are available from your next session.\n`,
      );
    } catch (e) {
      process.stderr.write(`ambient: couldn't sign in to ${name}: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  process.stderr.write(
    `ambient: unknown mcp command "${sub}" (use: ambient mcp [list | login <name> | logout <name>])\n`,
  );
  process.exitCode = 1;
}
