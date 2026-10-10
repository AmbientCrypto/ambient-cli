// Emits the publish-clean package.json for the CLI to stdout.
//
// The main bundle inlines workspace packages, zod and string-width. The published manifest
// declares the CLI's canonical runtime externals, all pure JavaScript with no native build.
// The package name defaults to "ambient-code" ("ambient-cli" is taken on npm); override with
// $NPM_NAME. The installed command is always `ambient` (and the `amb` alias), independent of the package name.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}/packages/cli/package.json`, "utf8"));
const name = process.env.NPM_NAME || "ambient-code";
const repo = "https://github.com/AmbientCrypto/ambient-cli";

process.stdout.write(
  `${JSON.stringify(
    {
      name,
      version: pkg.version,
      description:
        "A standalone terminal coding agent for the Ambient decentralized-inference network.",
      keywords: ["ambient", "cli", "coding-agent", "ai", "terminal", "tui", "llm"],
      homepage: `${repo}#readme`,
      repository: { type: "git", url: `git+${repo}.git` },
      bugs: { url: `${repo}/issues` },
      license: "MIT",
      type: "module",
      bin: { ambient: "dist/amb.js", amb: "dist/amb.js" },
      files: ["dist", "README.md", "LICENSE", "NOTICE", "npm-shrinkwrap.json"],
      engines: pkg.engines,
      dependencies: Object.fromEntries(
        pkg.ambient.runtimeExternals.map((name) => [name, pkg.dependencies[name]]),
      ),
    },
    null,
    2,
  )}\n`,
);
