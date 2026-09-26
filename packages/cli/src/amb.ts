import { exitQuietlyOnClosedPipe } from "./closed-pipe.js";
import { runChat } from "./commands/chat.js";
import { runConfig } from "./commands/config-show.js";
import { runDoctor } from "./commands/doctor.js";
import { runEval } from "./commands/eval.js";
import { runGitHub } from "./commands/github.js";
import { runHooks, runTrust } from "./commands/hooks.js";
import { runLogin, runLogout } from "./commands/login.js";
import { runMcp } from "./commands/mcp.js";
import { runModels } from "./commands/models.js";
import { runProbe } from "./commands/probe.js";
import { runResume } from "./commands/resume.js";
import { runRewind } from "./commands/rewind.js";
import { runRoute } from "./commands/route.js";
import { runAgent } from "./commands/run.js";
import { runSessions } from "./commands/sessions.js";
import { runSkills } from "./commands/skills.js";
import { runTuiCommand } from "./commands/tui.js";
import { HELP, commandHelp, wantsCommandHelp } from "./help.js";
import { CURRENT_VERSION } from "./version.js";

async function main(): Promise<void> {
  exitQuietlyOnClosedPipe(process.stdout);
  process.stderr.on("error", () => {}); // errors can't be reported anywhere once stderr itself fails
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  // `ambient <command> --help` only ever shows help — it never runs the command (`logout --help` must not
  // sign you out). `run`, `tui` and `chat` print their own fuller usage.
  if (wantsCommandHelp(cmd, rest)) {
    process.stdout.write(`${commandHelp(cmd as string)}\n`);
    return;
  }
  switch (cmd) {
    case "tui":
      await runTuiCommand(rest);
      break;
    case "run":
      await runAgent(rest);
      break;
    case "chat":
      await runChat(rest);
      break;
    case "models":
      await runModels(rest);
      break;
    case "skills":
      await runSkills(rest);
      break;
    case "hooks":
      await runHooks(rest);
      break;
    case "trust":
      await runTrust(rest);
      break;
    case "mcp":
      await runMcp(rest);
      break;
    case "probe":
      await runProbe(rest);
      break;
    case "route":
      await runRoute(rest);
      break;
    case "sessions":
      await runSessions(rest);
      break;
    case "resume":
      await runResume(rest);
      break;
    case "rewind":
      await runRewind(rest);
      break;
    case "eval":
      await runEval(rest);
      break;
    case "login":
      await runLogin();
      break;
    case "logout":
      runLogout();
      break;
    case "config":
      await runConfig(rest);
      break;
    case "github":
    case "gh":
      await runGitHub(rest);
      break;
    case "doctor":
      await runDoctor();
      break;
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(`ambient ${CURRENT_VERSION}\n`);
      break;
    case undefined:
      // Bare `amb` in a terminal launches the interactive TUI; otherwise show help (pipes/CI).
      if (process.stdin.isTTY && process.stdout.isTTY) await runTuiCommand([]);
      else process.stdout.write(`${HELP}\n`);
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP}\n`);
      break;
    default:
      // Bare `ambient "<task>" [flags]` — anything not a known subcommand is a run (flags included).
      await runAgent(argv);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ambient: ${message}\n`);
  process.exitCode = 1;
});
