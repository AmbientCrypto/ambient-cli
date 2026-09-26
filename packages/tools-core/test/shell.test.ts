import { describe, expect, it } from "vitest";
import { detectShell, shellInvocation } from "../src/shell.js";

const exists = (set: string[]) => (p: string) => set.includes(p);

describe("detectShell", () => {
  it("POSIX: prefers a real bash on PATH over /bin/sh (dash lacks bash-isms)", () => {
    const s = detectShell({ PATH: "/usr/local/bin:/usr/bin" }, "linux", exists(["/usr/bin/bash"]));
    expect(s).toMatchObject({ kind: "bash", path: "/usr/bin/bash" });
    expect(detectShell({ PATH: "/usr/bin" }, "linux", exists([]))).toMatchObject({
      kind: "sh",
      path: "/bin/sh",
    });
  });

  it("Windows: Git Bash first, never WSL's System32 bash", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      PATH: "C:\\Windows\\System32;C:\\tools",
      SystemRoot: "C:\\Windows",
    };
    const gitBash = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
    expect(
      detectShell(env, "win32", exists([gitBash, "C:\\Windows\\System32\\bash.exe"])),
    ).toMatchObject({
      kind: "bash",
      path: gitBash,
    });
    const wslOnly = detectShell(env, "win32", exists(["C:\\Windows\\System32\\bash.exe"]));
    expect(wslOnly.kind).not.toBe("bash");
  });

  it("Windows without Git Bash: PowerShell 7, else Windows PowerShell", () => {
    const env = { PATH: "C:\\pwsh", SystemRoot: "C:\\Windows" };
    expect(detectShell(env, "win32", exists(["C:\\pwsh\\pwsh.exe"])).kind).toBe("pwsh");
    const fallback = detectShell({ PATH: "", SystemRoot: "C:\\Windows" }, "win32", exists([]));
    expect(fallback.kind).toBe("powershell");
    expect(fallback.path.toLowerCase()).toContain("powershell.exe");
  });

  it("AMBIENT_SHELL overrides detection", () => {
    expect(
      detectShell({ AMBIENT_SHELL: "/opt/zsh" }, "darwin", exists(["/opt/zsh"])),
    ).toMatchObject({
      path: "/opt/zsh",
    });
  });
});

describe("shellInvocation", () => {
  it("bash gets -c; PowerShell gets non-interactive flags and UTF-8 output", () => {
    expect(shellInvocation({ kind: "bash", path: "/bin/bash", label: "bash" }, "ls -la")).toEqual([
      "-c",
      "ls -la",
    ]);
    const ps = shellInvocation(
      { kind: "pwsh", path: "pwsh.exe", label: "PowerShell" },
      "Get-ChildItem",
    );
    expect(ps.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(ps[3]).toContain("UTF8");
    expect(ps[3]).toContain("Get-ChildItem");
  });
});

describe("cleanTerminalOutput", () => {
  it("normalizes CRLF, keeps a progress bar's final state, and strips colors", async () => {
    const { cleanTerminalOutput } = await import("../src/tools/bash.js");
    expect(cleanTerminalOutput("a\r\nb\r\n")).toBe("a\nb\n");
    expect(cleanTerminalOutput("10%\r50%\r100% done\nnext")).toBe("100% done\nnext");
    expect(cleanTerminalOutput("\x1b[32mPASS\x1b[0m ok")).toBe("PASS ok");
  });
});

describe("msysGroupWinPids (Git Bash background jobs on Windows)", () => {
  it("finds every Windows pid in the command's Git Bash process group", async () => {
    const { msysGroupWinPids } = await import("../src/shell.js");
    const ps = [
      "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
      "     1872       1    1872      10688  ?         197609 19:04:43 /usr/bin/bash",
      "     1905    1872    1872       7710  ?         197609 19:04:43 /usr/bin/sleep",
      "     2001       1    2001       9900  ?         197609 19:04:44 /usr/bin/other",
    ].join("\n");
    expect(msysGroupWinPids(ps, 10688).sort()).toEqual([10688, 7710].sort());
    expect(msysGroupWinPids(ps, 4242)).toEqual([]);
  });
});
