import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The shell the `bash` tool runs commands in, chosen per machine so commands actually work everywhere:
 *  - macOS/Linux: a real `bash` from PATH (Debian/Ubuntu's `/bin/sh` is dash, which lacks bash syntax),
 *    falling back to `/bin/sh`.
 *  - Windows: Git Bash when installed (bash syntax works as the model expects; never WSL's System32 bash,
 *    which runs in a different filesystem), else PowerShell 7, else Windows PowerShell.
 * `AMBIENT_SHELL` overrides detection with an explicit executable.
 */
export type ShellKind = "bash" | "sh" | "pwsh" | "powershell";

export interface ShellInfo {
  kind: ShellKind;
  path: string;
  /** Human name for prompts/descriptions ("bash", "PowerShell"). */
  label: string;
}

type Env = Record<string, string | undefined>;

function onPath(name: string, env: Env, platform: NodeJS.Platform, exists: (p: string) => boolean) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of dirs) {
    if (!p.isAbsolute(d)) continue; // a relative entry (".") would resolve inside the user's project
    const full = p.join(d, name);
    if (exists(full)) return full;
  }
  return undefined;
}

function kindOf(exe: string): ShellKind {
  const base = exe.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "";
  if (base.startsWith("pwsh")) return "pwsh";
  if (base.startsWith("powershell")) return "powershell";
  if (base === "sh" || base === "sh.exe" || base === "dash") return "sh";
  return "bash";
}

const LABEL: Record<ShellKind, string> = {
  bash: "bash",
  sh: "sh",
  pwsh: "PowerShell",
  powershell: "PowerShell",
};

export function detectShell(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): ShellInfo {
  const make = (kind: ShellKind, p: string): ShellInfo => ({ kind, path: p, label: LABEL[kind] });
  const override = env.AMBIENT_SHELL?.trim();
  if (override && exists(override)) return make(kindOf(override), override);

  if (platform !== "win32") {
    const bash = onPath("bash", env, platform, exists);
    return bash ? make("bash", bash) : make("sh", "/bin/sh");
  }

  const w = path.win32;
  // Prefer Git's real bash (usr\bin) over its bin\ launcher: the launcher adds a process layer that a tree
  // kill doesn't reliably reach, which can leave a background child holding the output pipe.
  const gitRoots = [
    env.ProgramFiles && w.join(env.ProgramFiles, "Git"),
    env["ProgramFiles(x86)"] && w.join(env["ProgramFiles(x86)"] as string, "Git"),
    env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "Programs", "Git"),
  ].filter((p): p is string => typeof p === "string");
  const gitBash = gitRoots
    .flatMap((root) => [w.join(root, "usr", "bin", "bash.exe"), w.join(root, "bin", "bash.exe")])
    .find((p) => exists(p));
  if (gitBash) return make("bash", gitBash);
  const pathBash = onPath("bash.exe", env, platform, exists);
  if (pathBash && !/\\(system32|windowsapps)\\/i.test(pathBash)) return make("bash", pathBash);
  const pwsh = onPath("pwsh.exe", env, platform, exists);
  if (pwsh) return make("pwsh", pwsh);
  return make("powershell", windowsPowerShellExe(env));
}

/**
 * A Windows system program by absolute path. Windows looks in the current directory before PATH when a
 * program is started by bare name, and the current directory is the user's project — so a `taskkill.exe` or
 * `powershell.exe` committed to a repo would run instead of the real one.
 */
export function windowsSystemExe(relative: string, env: Env = process.env): string {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return path.win32.join(root, "System32", relative);
}

/** Windows PowerShell 5.1, by absolute path (always installed). */
export function windowsPowerShellExe(env: Env = process.env): string {
  return windowsSystemExe("WindowsPowerShell\\v1.0\\powershell.exe", env);
}

/**
 * The environment to run `shell` with. Git's own `bin\bash.exe` launcher normally puts Git's tool folders on
 * PATH and sets MSYSTEM; starting its bash directly skips that, so it's done here — otherwise `ls`, `sed` or
 * `sleep` aren't found on a machine whose PATH only has `Git\cmd`.
 */
export function shellEnv(shell: ShellInfo, env: Env = process.env): Env {
  const m = /^(.*)[\\/](?:usr[\\/])?bin[\\/]bash\.exe$/i.exec(shell.path);
  if (shell.kind !== "bash" || !m) return env;
  const root = m[1] as string;
  const w = path.win32;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const extra = [w.join(root, "usr", "bin"), w.join(root, "mingw64", "bin")];
  const current = env[pathKey] ?? "";
  return {
    ...env,
    [pathKey]: [...extra, current].filter(Boolean).join(";"),
    MSYSTEM: env.MSYSTEM ?? "MINGW64",
  };
}

/** Arguments that run `command` non-interactively in `shell`. PowerShell is told to emit UTF-8. */
export function shellInvocation(shell: ShellInfo, command: string): string[] {
  if (shell.kind === "pwsh" || shell.kind === "powershell") {
    return [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
    ];
  }
  return ["-c", command];
}

/** True when commands use POSIX shell syntax (the read-only command classifier only understands that). */
export function isPosixShell(shell: ShellInfo): boolean {
  return shell.kind === "bash" || shell.kind === "sh";
}

/**
 * Parse Git Bash's `ps` table and return the Windows pids of every process in the same Git Bash process group
 * as the process whose Windows pid is `winpid` (background jobs of a non-interactive bash share its group).
 */
export function msysGroupWinPids(psOutput: string, winpid: number): number[] {
  const lines = psOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = (lines[0] ?? "").trim().split(/\s+/);
  const iPgid = header.indexOf("PGID");
  const iWin = header.indexOf("WINPID");
  if (iPgid < 0 || iWin < 0) return [];
  // Rows may start with a one-letter status column (S/I) that has no header; drop it so columns line up.
  const rows = lines.slice(1).map((l) =>
    l
      .trim()
      .replace(/^[A-Z]\s+(?=\d)/, "")
      .split(/\s+/),
  );
  const self = rows.find((r) => Number(r[iWin]) === winpid);
  if (!self) return [];
  const pgid = self[iPgid];
  return rows
    .filter((r) => r[iPgid] === pgid)
    .map((r) => Number(r[iWin]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Git's `ps.exe` next to the Git Bash in use, if any. */
function gitPs(): string | undefined {
  const sh = machineShell();
  if (sh.kind !== "bash" || !/[\\/]usr[\\/]bin[\\/]/i.test(sh.path)) return undefined;
  const ps = path.win32.join(path.win32.dirname(sh.path), "ps.exe");
  return existsSync(ps) ? ps : undefined;
}

/**
 * Kill a process and everything it started: the process group on POSIX; on Windows `taskkill /T` plus, for
 * Git Bash, every process in the command's Git Bash process group — its background jobs are re-parented in a
 * way Windows' own process tree doesn't track, and would otherwise survive holding the output pipe.
 */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === "win32") {
      const ps = gitPs();
      const group = ps
        ? msysGroupWinPids(
            spawnSync(ps, ["-a"], { encoding: "utf8", windowsHide: true, timeout: 5_000 }).stdout ??
              "",
            pid,
          )
        : [];
      const taskkill = windowsSystemExe("taskkill.exe");
      spawnSync(taskkill, ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const rest = group.filter((p) => p !== pid);
      if (rest.length > 0) {
        spawnSync(taskkill, [...rest.flatMap((p) => ["/pid", String(p)]), "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      }
    } else {
      process.kill(-pid, "SIGKILL"); // negative pid = the whole group (the child is its own group leader)
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

let cached: ShellInfo | undefined;
/** The shell for this machine, detected once per process. */
export function machineShell(): ShellInfo {
  cached ??= detectShell();
  return cached;
}
