import { join } from "node:path";
import { readTextCappedSafe } from "@amb/context";
import { guardUntrustedResult } from "@amb/permissions";
import {
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
import { createBuiltinRegistry } from "@amb/tools-core";
import { resolveSessionId } from "./session-select.js";

/** True if `relPath` (resolved WITHIN `root`) exists and hashes to `expectedHash` (recovery: did the write
 *  land?). Contained + symlink-safe + size-bounded: a logged `../escape` path or a symlink can't read outside
 * the recorded workspace, and a huge file can't OOM the recovery check. */
function fileHashEquals(root: string, relPath: string, expectedHash: string): boolean {
  const text = readTextCappedSafe(join(root, relPath), { root, maxBytes: 4_194_304 });
  return text !== null && contentHash(text) === expectedHash;
}

/** What a run needs to carry on from an earlier session. */
export interface ResumeContext {
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
  const { events, chainIntact, interiorCorruption, droppedTail } = readSession(fromSessionId);
  if (!chainIntact || interiorCorruption) {
    return {
      error: `session ${fromSessionId}'s log is incomplete or damaged, so it can't be resumed`,
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
  const context = [
    reconstructTranscript(events, (t) => guardUntrustedResult(t).text),
    renderOutstandingPlan(latestPlan(events)),
    recoveryBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
  const goal = latestGoal(events);
  const priorLastEventId = events.at(-1)?.eventId;
  return {
    fromSessionId,
    context,
    ...(goal ? { goal } : {}),
    ...(priorLastEventId ? { priorLastEventId } : {}),
    recoveryNotes: notes,
    droppedTail,
  };
}
