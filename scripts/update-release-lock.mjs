import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const stage = mkdtempSync(join(tmpdir(), "ambient-lock-"));
try {
  writeFileSync(
    join(stage, "package.json"),
    execFileSync(process.execPath, [join(root, "scripts/npm-package-json.mjs")]),
  );
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: stage, stdio: "inherit", shell: process.platform === "win32" },
  );
  mkdirSync(join(root, "packaging"), { recursive: true });
  writeFileSync(
    join(root, "packaging/npm-shrinkwrap.json"),
    readFileSync(join(stage, "package-lock.json")),
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
