import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSession, sessionsDir, turnCount } from "@amb/sessions";
import { bold, dim } from "../render/color.js";
import { RUN_VALUE_FLAGS } from "./run-args.js";
import { runAgent } from "./run.js";

function listResumable(): void {
  const dir = sessionsDir();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  if (files.length === 0) {
    process.stdout.write("No sessions to resume yet.\n");
    return;
  }
  const rows = files
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  process.stdout.write(`${bold("Resumable sessions")} ${dim("(newest first)")}\n\n`);
  for (const r of rows.slice(0, 15)) {
    const { events } = readSession(r.id);
    const turns = turnCount(events);
    if (turns === 0) continue;
    const first = events.find(
      (e): e is Extract<typeof e, { kind: "turn.started" }> => e.kind === "turn.started",
    );
    process.stdout.write(
      `  ${r.id}  ${dim(`${turns} turn(s)`)}${first ? dim(` · "${first.input.slice(0, 50)}"`) : ""}\n`,
    );
  }
  process.stdout.write(dim('\nResume with:  ambient resume <id|latest> "<next instruction>"\n'));
}

/**
 * `ambient resume` lists sessions; `ambient resume <id|latest> "<instruction>" [flags]` continues one — the
 * same run as `ambient run --resume <id>`, with every run flag available.
 */
export async function runResume(args: string[]): Promise<void> {
  // The first word that isn't a flag (or a flag's value) is the session.
  const takesValue = RUN_VALUE_FLAGS;
  let idAt = -1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (takesValue.has(a)) i++;
    else if (!a.startsWith("-")) {
      idAt = i;
      break;
    }
  }
  if (idAt < 0) {
    listResumable();
    return;
  }
  const rest = args.filter((_, i) => i !== idAt);
  if (!rest.some((a, i) => !a.startsWith("-") && !takesValue.has(rest[i - 1] ?? ""))) {
    process.stderr.write(
      'ambient: resume needs a new instruction, e.g. ambient resume latest "now add tests"\n',
    );
    process.exitCode = 1;
    return;
  }
  await runAgent(["--resume", args[idAt] as string, ...rest]);
}
