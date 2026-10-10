import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { installKind, updateCommand } from "./update-check.js";

const RUNTIME_PACKAGES = ["ink", "react", "undici", "cross-spawn", "yaml", "unpdf"] as const;
const require = createRequire(import.meta.url);

function dependencyVersion(name: string): string {
  let dir = dirname(require.resolve(name));
  while (dirname(dir) !== dir) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === name && typeof pkg.version === "string") return pkg.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    dir = dirname(dir);
  }
  throw new Error(`Cannot find the installed version of ${name}`);
}

export function installationHealth(): { lines: string[]; errors: string[] } {
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : import.meta.url;
  const kind = installKind(entry);
  const errors: string[] = [];
  const dependencies = RUNTIME_PACKAGES.map((name) => {
    try {
      return `${name}@${dependencyVersion(name)}`;
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}; reinstall with ${updateCommand(kind)}`);
      return `${name}: missing`;
    }
  });
  return {
    lines: [
      `installation ${kind} · ${entry}`,
      `runtime ${process.execPath}`,
      `dependencies ${dependencies.join(", ")}`,
      `update: ${updateCommand(kind)}`,
    ],
    errors,
  };
}
