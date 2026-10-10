import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inject the real package version at build time so `--version` never drifts from package.json (it used to
// print a hardcoded "0.1.0"). Under tsc/vitest (no esbuild define) the code falls back to "dev".
const { version, engines, ambient } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
const minNode = Number(/^>=(\d+)/.exec(engines.node)?.[1]);

export default defineConfig({
  entry: { amb: "src/bootstrap.ts", main: "src/amb.ts" },
  format: ["esm"],
  target: `node${minNode}`,
  metafile: true,
  clean: true,
  define: { __AMB_VERSION__: JSON.stringify(version), __AMB_MIN_NODE__: String(minNode) },
  // Bundle the workspace packages + pure-JS deps into main.js. React/Ink stay
  // external (installed in node_modules) — they use conditional exports that don't bundle cleanly.
  // string-width (and its deps) are pure JS and MUST be bundled — they aren't declared in the published
  // manifest, so leaving them external would break a global install.
  noExternal: [/^@amb\//, "zod", "string-width"],
  // undici (web_fetch's IP-pinned dispatcher) stays external — it's CJS with `require("assert")` internals
  // that don't survive ESM bundling; loaded from node_modules at runtime like react/ink.
  external: [...ambient.runtimeExternals, "react/jsx-runtime", "better-sqlite3", "node-pty"],
  banner: { js: "#!/usr/bin/env node" },
  // The TUI uses the automatic JSX runtime (no classic `import React`); tell esbuild to match.
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
