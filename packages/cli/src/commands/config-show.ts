import { existsSync } from "node:fs";
import { configPath, loadConfig } from "../config.js";
import { bold, dim } from "../render/color.js";

/**
 * `amb config` / `amb config show` — print where the config lives + the resolved values.
 * `amb config path` — print just the path (scriptable).
 * Read-only: it never writes the file (the user edits it by hand; a typo just warns + is ignored).
 */
export async function runConfig(args: string[]): Promise<void> {
  const path = configPath();
  if (args[0] === "path") {
    process.stdout.write(`${path}\n`);
    return;
  }
  const exists = existsSync(path);
  const config = loadConfig();
  process.stdout.write(
    `${bold("config")} ${dim(path)}${exists ? "" : dim("  (not created yet)")}\n`,
  );
  if (!exists) {
    process.stdout.write(
      `${dim("\nCreate it to set defaults. Example:\n")}` +
        `${dim('  { "model": "auto", "mode": "ask", "permissions": { "allow": ["Bash(npm test:*)"] } }\n')}`,
    );
    return;
  }
  const keys = Object.keys(config);
  if (keys.length === 0) {
    process.stdout.write(dim("\n(empty — all built-in defaults apply)\n"));
    return;
  }
  process.stdout.write(`\n${JSON.stringify(config, null, 2)}\n`);
}
