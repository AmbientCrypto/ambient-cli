import { spawn } from "node:child_process";
import { ghInstallCommand, githubStatus, githubSummary } from "../agent/github.js";
import { bold, dim } from "../render/color.js";

const USAGE = "usage: ambient github [status|login]";

/**
 * `ambient github [status|login]`
 *   status (default) — show GitHub sign-in state (account / token / not signed in).
 *   login            — run `gh auth login` interactively (inherits your terminal). Requires the gh CLI.
 * We never store or print a token; login is delegated entirely to gh's own secure flow.
 */
export async function runGitHub(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";

  if (sub === "status") {
    const s = githubStatus();
    process.stdout.write(`${bold("github")}  ${githubSummary(s)}\n`);
    if (!s.authed) {
      if (!s.ghInstalled) {
        process.stdout.write(
          dim(`\nInstall the GitHub CLI:  ${ghInstallCommand()}\nThen:  ambient github login\n`),
        );
      } else {
        process.stdout.write(dim("\nSign in:  ambient github login\n"));
      }
    }
    return;
  }

  if (sub === "login") {
    const s = githubStatus();
    if (!s.ghInstalled) {
      process.stderr.write(
        `ambient: the GitHub CLI (gh) isn't installed. Install it with \`${ghInstallCommand()}\`, then run \`ambient github login\`.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(dim("Launching `gh auth login` — follow the prompts…\n"));
    // Inherit stdio so gh's interactive login (device code / browser) drives the real terminal.
    const code = await new Promise<number>((resolve) => {
      const child = spawn("gh", ["auth", "login"], { stdio: "inherit" });
      child.on("close", (c) => resolve(c ?? 1));
      child.on("error", () => resolve(1));
    });
    if (code === 0) {
      const after = githubStatus();
      process.stdout.write(`\n${githubSummary(after)}\n`);
    } else {
      process.stderr.write("\nambient: `gh auth login` did not complete.\n");
      process.exitCode = code;
    }
    return;
  }

  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}
