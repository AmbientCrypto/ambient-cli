import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type Event,
  isSafeSessionId,
  readSession,
  sessionsDir,
  transcriptText,
} from "@amb/sessions";
import { bold, dim } from "../render/color.js";

/** `amb sessions [list|show <id>]` — inspect the crash-safe session logs. */
export async function runSessions(args: string[]): Promise<void> {
  const [sub, arg] = args;
  if (sub === "show" && arg) {
    showSession(arg);
    return;
  }
  listSessions();
}

function listSessions(): void {
  const dir = sessionsDir();
  if (!existsSync(dir)) {
    process.stdout.write("No sessions yet.\n");
    return;
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    process.stdout.write("No sessions yet.\n");
    return;
  }
  process.stdout.write(`${bold("SESSIONS")}\n\n`);
  for (const f of files) {
    const { events, chainIntact } = readSession(f.id);
    const turns = events.filter((e) => e.kind === "turn.started").length;
    const started = events.find(
      (e): e is Extract<Event, { kind: "session.started" }> => e.kind === "session.started",
    );
    const flag = chainIntact ? "" : dim(" [chain broken]");
    process.stdout.write(
      `  ${f.id}  ${dim(`${events.length} events · ${turns} turn(s)`)}${flag}\n`,
    );
    if (started) process.stdout.write(`    ${dim(started.workspaceRoot)}\n`);
  }
}

function showSession(id: string): void {
  // Validate before any filesystem op — a `../`-style id must never address a file outside the sessions dir.
  if (!isSafeSessionId(id)) {
    process.stderr.write(`ambient: invalid session id: ${id}\n`);
    process.exitCode = 1;
    return;
  }
  const { events, chainIntact, droppedTail } = readSession(id);
  if (events.length === 0) {
    process.stderr.write(`No such session: ${id}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${bold(id)} ${dim(`${events.length} events · chain ${chainIntact ? "ok" : "broken"} · droppedTail ${droppedTail}`)}\n\n`,
  );
  process.stdout.write(`${transcriptText(events)}\n`);
}
