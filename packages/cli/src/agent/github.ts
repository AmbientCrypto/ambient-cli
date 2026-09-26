import { execFileSync } from "node:child_process";

const GH_TIMEOUT_MS = 4000;

export interface GitHubStatus {
  /** Is the `gh` CLI installed + on PATH? */
  ghInstalled: boolean;
  /** Is the user authenticated (via gh, or a token env var)? */
  authed: boolean;
  /** The logged-in github.com account (username), when gh reports one. */
  account?: string;
  /** A token env var that's set (GH_TOKEN / GITHUB_TOKEN), if any — auth even without gh login. */
  tokenEnv?: "GH_TOKEN" | "GITHUB_TOKEN";
}

/** Run a command, returning combined stdout+stderr trimmed, or undefined on any failure. Never throws. */
function tryRun(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    // gh writes `auth status` to stderr and exits non-zero when signed out — capture that output anyway.
    const e = err as { stdout?: string; stderr?: string };
    const combined = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    return combined.length > 0 ? combined : undefined;
  }
}

/** Parse the account name from `gh auth status` output (line: "✓ Logged in to github.com account NAME (…)"). */
function parseAccount(output: string): string | undefined {
  const m = output.match(/account\s+([A-Za-z0-9-]+)/);
  return m?.[1];
}

/** How githubStatus shells out — injectable so tests are hermetic (no real `gh` subprocess). */
export type Runner = (cmd: string, args: string[]) => string | undefined;

/**
 * Detect the user's GitHub sign-in state without ever storing or printing a token. Prefers `gh auth status`;
 * also recognizes a GH_TOKEN / GITHUB_TOKEN env var (which authenticates gh + git even without an interactive
 * login). `env` and `run` are injectable for tests.
 */
export function githubStatus(
  env: Record<string, string | undefined> = process.env,
  run: Runner = tryRun,
): GitHubStatus {
  const version = run("gh", ["--version"]);
  const ghInstalled = version !== undefined && /gh version/i.test(version);

  const tokenEnv = env.GH_TOKEN?.trim()
    ? "GH_TOKEN"
    : env.GITHUB_TOKEN?.trim()
      ? "GITHUB_TOKEN"
      : undefined;

  if (!ghInstalled) {
    // No gh, but a token env still authenticates plain-git pushes over HTTPS.
    return {
      ghInstalled: false,
      authed: tokenEnv !== undefined,
      ...(tokenEnv ? { tokenEnv } : {}),
    };
  }

  const status = run("gh", ["auth", "status"]);
  const authed = (status !== undefined && /Logged in to/i.test(status)) || tokenEnv !== undefined;
  const account = status ? parseAccount(status) : undefined;
  return {
    ghInstalled: true,
    authed,
    ...(account ? { account } : {}),
    ...(tokenEnv ? { tokenEnv } : {}),
  };
}

/** The command that installs the GitHub CLI on this OS. */
export function ghInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "winget install GitHub.cli";
  if (platform === "linux") return "see https://cli.github.com (e.g. sudo apt install gh)";
  return "brew install gh";
}

/** A one-line human summary of GitHub sign-in state (for `doctor` + `github status`). */
export function githubSummary(s: GitHubStatus): string {
  if (!s.ghInstalled && !s.authed) {
    return `GitHub: gh CLI not installed (${ghInstallCommand()}) — or set GITHUB_TOKEN`;
  }
  if (s.authed) {
    const who = s.account ? ` as ${s.account}` : "";
    const via = s.tokenEnv ? ` (${s.tokenEnv})` : "";
    return `GitHub: signed in${who}${via}`;
  }
  return "GitHub: not signed in — run `ambient github login`";
}
