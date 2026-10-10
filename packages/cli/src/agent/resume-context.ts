import { join } from "node:path";
import { readTextCappedSafe } from "@amb/context";
import { guardUntrustedResult } from "@amb/permissions";
import {
  RECOVERY_LIMITS,
  contentHash,
  latestGoal,
  latestPlan,
  readSession,
  reconcile,
  reconstructTranscript,
  recoveryNotes,
  renderOutstandingPlan,
  unsettledTools,
} from "@amb/sessions";
import type { PlanTask } from "@amb/sessions";
import { createBuiltinRegistry } from "@amb/tools-core";
import { type RecoveredMessage, recoverMessages } from "./recovered-messages.js";
import { resolveSessionId } from "./session-select.js";

const RECOVERY_CONTEXT_CHARS = 128_000;
const RECOVERY_TASK_CHARS = 64_000;

/** True if `relPath` (resolved WITHIN `root`) exists and hashes to `expectedHash` (recovery: did the write
 *  land?). Contained + symlink-safe + size-bounded: a logged `../escape` path or a symlink can't read outside
 * the recorded workspace, and a huge file can't OOM the recovery check. */
function fileHashEquals(root: string, relPath: string, expectedHash: string): boolean {
  const text = readTextCappedSafe(join(root, relPath), { root, maxBytes: 4_194_304 });
  return text !== null && contentHash(text) === expectedHash;
}

/** What a run needs to carry on from an earlier session. */
export interface ResumeContext {
  interrupted: boolean;
  task?: string;
  plan: PlanTask[];
  pendingMessages: RecoveredMessage[];
  fromSessionId: string;
  /** The prior transcript, outstanding plan and interrupted-work notes, for the model. */
  context: string;
  goal?: string;
  priorLastEventId?: string;
  /** Interrupted tool calls reconciled against the files on disk. */
  recoveryNotes: string[];
  /** Unfinished log lines dropped from the end of the prior log. */
  droppedTail: number;
}

/**
 * Load a session to continue: `latest` (optionally the latest in this folder) or an id. Refuses a log whose
 * hash chain is broken. Interrupted tool calls are reconciled against the files the ORIGINAL session wrote
 * (not the folder resumed from), so the model knows exactly which effect to re-verify.
 */
export function loadResumeContext(
  idOrLatest: string,
  opts: { workspaceRoot?: string } = {},
): ResumeContext | { error: string } {
  const fromSessionId = resolveSessionId(idOrLatest, opts);
  if (!fromSessionId) {
    return {
      error:
        idOrLatest && idOrLatest !== "latest"
          ? `no session "${idOrLatest}" (ambient resume lists them)`
          : opts.workspaceRoot
            ? "no earlier conversation in this folder to continue"
            : "no earlier session to resume",
    };
  }
  const { events, chainIntact, interiorCorruption, droppedTail, error } = readSession(
    fromSessionId,
    undefined,
    RECOVERY_LIMITS,
  );
  if (!chainIntact || interiorCorruption) {
    return {
      error:
        error ?? `session ${fromSessionId}'s log is incomplete or damaged, so it can't be resumed`,
    };
  }
  const recordedRoot =
    events.find((e) => e.kind === "session.started")?.workspaceRoot ?? process.cwd();
  const builtins = createBuiltinRegistry();
  const lookup = (name: string) => {
    const m = builtins.get(name)?.manifest;
    return m ? { effects: m.effects, idempotency: m.idempotency } : undefined;
  };
  const notes = recoveryNotes(reconcile(unsettledTools(events), lookup), (r) =>
    r.path && r.expectedPostimageHash
      ? fileHashEquals(recordedRoot, r.path, r.expectedPostimageHash)
      : false,
  );
  const recoveryBlock =
    notes.length > 0
      ? `## Interrupted work (reconcile before continuing)\n${notes.map((n) => `- ${n}`).join("\n")}`
      : "";
  const task = events.findLast((event) => event.kind === "turn.started")?.input;
  const checkpoint = events.findLast(
    (event) =>
      (event.kind === "context.compacted" && event.summary) ||
      (event.kind === "session.resumed" && event.context),
  );
  const summary =
    checkpoint?.kind === "context.compacted"
      ? checkpoint.summary
      : checkpoint?.kind === "session.resumed"
        ? checkpoint.context
        : undefined;
  const context = [
    task ? `## Original task\n${task.slice(0, RECOVERY_TASK_CHARS)}` : "",
    summary
      ? `## Earlier checkpoint (re-verify facts)\n${guardUntrustedResult(summary.slice(-RECOVERY_CONTEXT_CHARS)).text}`
      : "",
    reconstructTranscript(events, (t) => guardUntrustedResult(t).text).slice(
      -RECOVERY_CONTEXT_CHARS,
    ),
    renderOutstandingPlan(latestPlan(events)),
    recoveryBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
  const goal = latestGoal(events);
  const priorLastEventId = events.at(-1)?.eventId;
  let pending: RecoveredMessage[];
  try {
    pending = recoverMessages(fromSessionId, events);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const lastFinished = events.findLast((event) => event.kind === "turn.finished");
  const lastStarted = events.findLast((event) => event.kind === "turn.started");
  const interrupted =
    pending.length > 0 ||
    notes.length > 0 ||
    (!!lastStarted &&
      (!lastFinished ||
        lastFinished.seq < lastStarted.seq ||
        !["complete", "cancelled", "stopped_by_hook"].includes(lastFinished.stopReason)));
  return {
    interrupted,
    plan: latestPlan(events),
    pendingMessages: pending,
    ...(task ? { task } : {}),
    fromSessionId,
    context,
    ...(goal ? { goal } : {}),
    ...(priorLastEventId ? { priorLastEventId } : {}),
    recoveryNotes: notes,
    droppedTail,
  };
}
