import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("tsup"))("esbuild");
const scratch = mkdtempSync(join(tmpdir(), "ambient-stress-"));
try {
  symlinkSync(
    join(root, "packages/cli/node_modules"),
    join(scratch, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const outfile = join(scratch, "stress.mjs");
  esbuild.buildSync({
    stdin: {
      contents: readFileSync(join(root, "packages/cli/test/fixtures/tui-stress.mjs"), "utf8"),
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    jsx: "automatic",
    outfile,
    external: [
      "ink",
      "react",
      "react/jsx-runtime",
      "undici",
      "cross-spawn",
      "yaml",
      "unpdf",
      "better-sqlite3",
      "node-pty",
    ],
  });
  const result = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=512", outfile], {
    cwd: scratch,
    stdio: "inherit",
    timeout: 20 * 60_000,
    env: {
      ...process.env,
      CI: "false",
      AMBIENT_NO_UPDATE_CHECK: "1",
      AMB_HOME: join(scratch, "private"),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`TUI stress failed (${result.status})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
