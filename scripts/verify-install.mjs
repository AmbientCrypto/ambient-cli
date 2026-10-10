import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(
  execFileSync(process.execPath, [join(root, "scripts/npm-package-json.mjs")], {
    encoding: "utf8",
  }),
);
const tarball = join(root, "dist-pack", `${pkg.name}-${pkg.version}.tgz`);
const scratch = mkdtempSync(join(tmpdir(), "ambient-install-"));
const env = {
  ...process.env,
  NODE_PATH: "",
  AMBIENT_NO_UPDATE_CHECK: "1",
  AMB_HOME: join(scratch, "private"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_CACHE_HOME: join(scratch, "cache"),
};
const npm = (args) =>
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: scratch,
    env,
    stdio: "pipe",
    timeout: 120_000,
    shell: process.platform === "win32",
  });
const hash = () => createHash("sha256").update(readFileSync(tarball)).digest("hex");
function check(prefix) {
  const installed = join(
    prefix,
    process.platform === "win32" ? "node_modules" : "lib/node_modules",
    pkg.name,
  );
  const entry = join(installed, "dist/amb.js");
  const run = (args) =>
    execFileSync(process.execPath, [entry, ...args], {
      cwd: scratch,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
  if (run(["--version"]).trim() !== `ambient ${pkg.version}`)
    throw new Error("Installed version drift");
  const health = run(["doctor", "--offline"]);
  if (!health.includes("ink@8.0.0") || !health.includes("built-in tools"))
    throw new Error(`Runtime smoke failed: ${health}`);
  run(["--help"]);
  const probe = join(scratch, "probe.mjs");
  writeFileSync(
    probe,
    `import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url'; import {Writable} from 'node:stream';
    const require = createRequire(${JSON.stringify(entry)});
    const load = (name) => import(pathToFileURL(require.resolve(name)).href);
    const ink = await load('ink'); const React = await load('react');
    const yaml = await load('yaml'); if (yaml.parse('test: true').test !== true) throw Error('yaml');
    const pdf = await load('unpdf'); if (typeof pdf.extractText !== 'function') throw Error('unpdf');
    const undici = await load('undici'); const agent = new undici.Agent(); await agent.close();
    const spawn = (await load('cross-spawn')).default; const result = spawn.sync(process.execPath, ['-e', 'process.stdout.write("ok")']); if (result.stdout.toString() !== 'ok') throw Error('cross-spawn');
    let output = ''; const stdout = new Writable({write(chunk, encoding, done) {output = (output + chunk.toString()).slice(-4096); done();}});
    const view = ink.render(React.createElement(ink.Text, {}, 'packaged TUI ready'), {stdout, patchConsole: false, exitOnCtrlC: false});
    view.unmount(); if (!output.includes('packaged TUI ready')) throw Error('TUI');
  `,
  );
  execFileSync(process.execPath, [probe], { cwd: scratch, env, stdio: "pipe", timeout: 20_000 });
  const lock = JSON.parse(readFileSync(join(installed, "npm-shrinkwrap.json"), "utf8"));
  if (lock.packages["node_modules/ink"].version !== "8.0.0")
    throw new Error("Release lock was lost");
  for (const [path, locked] of Object.entries(lock.packages)) {
    if (!path) continue;
    const actual = JSON.parse(readFileSync(join(installed, path, "package.json"), "utf8"));
    if (actual.version !== locked.version)
      throw new Error(`Installed dependency drift: ${path} ${actual.version} != ${locked.version}`);
  }
}
try {
  for (const kind of ["fresh", "upgrade"]) {
    const prefix = join(scratch, kind);
    if (kind === "upgrade")
      npm([
        "install",
        "--global",
        "--prefix",
        prefix,
        `${pkg.name}@1.0.4`,
        "--no-audit",
        "--no-fund",
      ]);
    npm(["install", "--global", "--prefix", prefix, tarball, "--no-audit", "--no-fund"]);
    check(prefix);
    process.stdout.write(
      `Verified ${kind}: ${pkg.version}, locked dependencies, TUI and lazy tools\n`,
    );
  }
  writeFileSync(
    join(root, "dist-pack", `${pkg.name}-${pkg.version}.verified.json`),
    `${JSON.stringify({ version: pkg.version, sha256: hash(), node: process.version })}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
