import { describe, expect, it } from "vitest";
import { verifyRunner } from "../src/agent/verify-port.js";

const has =
  (...files: string[]) =>
  (p: string) =>
    files.some((f) => p.replace(/\\/g, "/").endsWith(f));
const bash = () => ({ kind: "bash" as const, path: "C:\\Git\\bin\\bash.exe", label: "bash" });
const pwsh = () => ({ kind: "pwsh" as const, path: "C:\\pwsh\\pwsh.exe", label: "PowerShell" });

describe("verifyRunner", () => {
  it("POSIX: runs an executable script with a #! line directly, else through /bin/sh", () => {
    const shebang = () => true;
    const noShebang = () => false;
    expect(
      verifyRunner("/w", "linux", has(".ambient/verify"), () => true, undefined, shebang)?.args,
    ).toEqual([]);
    // Executable but no #! line: exec would fail (ENOEXEC), so it goes through /bin/sh.
    expect(
      verifyRunner("/w", "darwin", has(".ambient/verify"), () => true, undefined, noShebang)
        ?.command,
    ).toBe("/bin/sh");
    expect(verifyRunner("/w", "linux", has(".ambient/verify"), () => false)?.command).toBe(
      "/bin/sh",
    );
    expect(verifyRunner("/w", "linux", has(), () => true)).toBeUndefined();
  });
  it("Windows: prefers verify.ps1, then verify.cmd, then a plain script via Git Bash", () => {
    const ps1 = verifyRunner("C:\\w", "win32", has("verify.ps1"), () => false, pwsh);
    expect(ps1?.command).toBe("C:\\pwsh\\pwsh.exe");
    expect(ps1?.args).toContain("-File");
    const cmd = verifyRunner("C:\\w", "win32", has("verify.cmd"), () => false, pwsh);
    expect(cmd?.args.at(-1)).toMatch(/verify\.cmd$/);
    expect(verifyRunner("C:\\w", "win32", has("verify"), () => false, bash)?.command).toBe(
      "C:\\Git\\bin\\bash.exe",
    );
    // Git's own tool folders are put on PATH for the script.
    const viaBash = verifyRunner("C:\\w", "win32", has("verify"), () => false, bash);
    expect(String(viaBash?.env?.PATH ?? viaBash?.env?.Path)).toContain("C:\\Git\\usr\\bin");
  });
  it("Windows: a .cmd runs by its relative path, so the workspace path never reaches cmd.exe", () => {
    const r = verifyRunner("C:\\Work (x86) & co", "win32", has("verify.cmd"), () => false, pwsh);
    expect(r?.args).toEqual(["/d", "/c", ".ambient\\verify.cmd"]);
  });
  it("Windows with only a POSIX script and no Git Bash: verification is OFF, never a fake failure", () => {
    expect(verifyRunner("C:\\w", "win32", has("verify"), () => false, pwsh)).toBeUndefined();
  });
});

describe("verifyRunner on disk", () => {
  it.runIf(process.platform !== "win32")(
    "runs a compiled verify program directly, and a #!-less script through /bin/sh",
    async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "amb-verify-"));
      try {
        mkdirSync(join(dir, ".ambient"));
        const file = join(dir, ".ambient", "verify");
        writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
        chmodSync(file, 0o755);
        expect(verifyRunner(dir)?.command).toBe(file);
        writeFileSync(file, "pnpm test\n");
        expect(verifyRunner(dir)?.command).toBe("/bin/sh");
        writeFileSync(file, "#!/bin/sh\npnpm test\n");
        expect(verifyRunner(dir)?.command).toBe(file);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
