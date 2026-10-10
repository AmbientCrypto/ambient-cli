import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
let scratch: string;
let repo: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ambient-source-install-"));
  repo = join(scratch, "source repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "packages/cli/dist"), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url)),
    join(repo, "scripts/install.sh"),
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ packageManager: "pnpm@9.12.0" }));
  writeFileSync(join(repo, "packages/cli/dist/amb.js"), 'console.log("ambient 1.0.4");');
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));
it("pins pnpm, uses a frozen lock, and replaces launchers only after smoke checks", () => {
  const log = join(scratch, "commands");
  writeFileSync(
    join(scratch, "pnpm"),
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo 0.0.0; else exit 2; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(scratch, "npx"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$TASK_PNPM_LOG"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${scratch}${delimiter}${process.env.PATH}`,
    TASK_PNPM_LOG: log,
    BIN_DIR: join(scratch, "bin"),
    AMB_HOME: join(scratch, "private"),
    AMBIENT_NO_UPDATE_CHECK: "1",
  };
  execFileSync("bash", [join(repo, "scripts/install.sh")], { env, timeout: 20000, stdio: "pipe" });
  expect(readFileSync(log, "utf8")).toContain("--yes pnpm@9.12.0 install --frozen-lockfile");
  expect(readFileSync(log, "utf8")).toContain("--yes pnpm@9.12.0 -r build");
  const launcher = readFileSync(join(scratch, "bin/ambient"), "utf8");
  expect(launcher).toMatch(/^exec .+node(?:\.exe)? /m);
  expect(launcher).toContain("packages/cli/dist/amb.js");
  expect(
    execFileSync("bash", [join(scratch, "bin/amb"), "--version"], { env, encoding: "utf8" }),
  ).toContain("ambient 1.0.4");
});
it("does not replace launchers when installation fails", () => {
  writeFileSync(
    join(scratch, "pnpm"),
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo 9.12.0; else exit 7; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(join(scratch, "ambient"), "keep previous launcher");
  expect(() =>
    execFileSync("bash", [join(repo, "scripts/install.sh")], {
      env: { ...process.env, PATH: `${scratch}${delimiter}${process.env.PATH}`, BIN_DIR: scratch },
      stdio: "pipe",
    }),
  ).toThrow();
  expect(readFileSync(join(scratch, "ambient"), "utf8")).toBe("keep previous launcher");
});
