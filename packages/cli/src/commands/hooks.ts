import { workspaceSettings } from "../agent/workspace-settings.js";
import { configDir, loadConfig } from "../config.js";

/** `ambient trust` shows what this project's own settings ask for; `ambient trust yes` trusts exactly that. */
export async function runTrust(args: string[]): Promise<void> {
  const config = loadConfig();
  const settings = workspaceSettings(process.cwd(), config, configDir());
  const sub = args[0];
  if (sub === undefined) {
    process.stdout.write(`${settings.trustSummary().join("\n")}\n`);
    return;
  }
  if (sub === "yes") {
    process.stdout.write(`${settings.trust()}\n`);
    return;
  }
  process.stderr.write(`ambient: unknown trust command "${sub}" (use: ambient trust [yes])\n`);
  process.exitCode = 1;
}

/** `ambient hooks` lists the hooks that run in this folder (`ambient trust` reviews the project's own). */
export async function runHooks(args: string[]): Promise<void> {
  const config = loadConfig();
  const control = workspaceSettings(process.cwd(), config, configDir());
  const sub = args[0];
  if (sub === undefined || sub === "list") {
    process.stdout.write(`${control.hooksSummary().join("\n")}\n`);
    return;
  }
  process.stderr.write(
    `ambient: unknown hooks command "${sub}" (use: ambient hooks; ambient trust reviews this project's settings)\n`,
  );
  process.exitCode = 1;
}
