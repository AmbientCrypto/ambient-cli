import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type SessionWriter, ambHome } from "@amb/sessions";
import { z } from "zod";

const Choice = z.object({
  fromSessionId: z
    .string()
    .regex(/^ses_[a-zA-Z0-9_-]+$/)
    .max(256),
  priorLastEventId: z.string().max(256).optional(),
});
type RecoveryChoice = z.infer<typeof Choice>;
const MAX_CHOICE_BYTES = 1024;

/** Clean quits are explicit; an OOM or unhandled crash never writes a close record. */
export class SessionLifecycle {
  private current?: { writer: SessionWriter; sessionId: string; closed: boolean };
  constructor(private readonly home: string = ambHome()) {}

  private choicePath(recovery: RecoveryChoice): string {
    return join(this.home, "recovery-choices", `${Choice.parse(recovery).fromSessionId}.json`);
  }

  attach(writer: SessionWriter, sessionId: string): void {
    this.current = { writer, sessionId, closed: false };
  }

  close(reason: "quit" | "signal"): void {
    if (!this.current || this.current.closed) return;
    const { writer, sessionId } = this.current;
    writer.append({ schemaVersion: 1, kind: "session.closed", sessionId, reason });
    this.current = { ...this.current, closed: true };
  }

  dismiss(recovery: RecoveryChoice): void {
    const choice = Choice.parse({
      fromSessionId: recovery.fromSessionId,
      priorLastEventId: recovery.priorLastEventId,
    });
    const path = this.choicePath(choice);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(choice), { mode: 0o600 });
  }

  dismissed(recovery: RecoveryChoice): boolean {
    const path = this.choicePath(recovery);
    if (!existsSync(path)) return false;
    if (statSync(path).size > MAX_CHOICE_BYTES)
      throw new Error("Saved recovery choice exceeds its safe size");
    const choice = Choice.parse(JSON.parse(readFileSync(path, "utf8")));
    return (
      choice.fromSessionId === recovery.fromSessionId &&
      choice.priorLastEventId === recovery.priorLastEventId
    );
  }
}
