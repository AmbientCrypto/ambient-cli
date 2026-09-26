import type { Event } from "@amb/protocol";
import { contentHash } from "./objects.js";

/**
 * Crash-recovery PROJECTORS (feature #38) — pure folds over a durable event log, used when RESUMING a
 * session that may have ended mid-tool (a `tool.started` with no matching `tool.result`) or with an
 * outstanding plan. They never touch the filesystem; the CLI edge does the one fs comparison an `inspect`
 * reconciliation needs (mirroring how `rewind` hashes the working tree at the edge).
 *
 * The write side of intent→settlement already exists: `execute-tools` emits `tool.started` BEFORE running a
 * tool and `tool.result`/`file.mutation` AFTER — so an unsettled tool has NO mutation record and its effect
 * is genuinely unknown. This module is the READ side that reconciles those danglers on resume.
 */

export interface PlanTask {
  text: string;
  status: "pending" | "active" | "done";
}

/** Defensively parse a `plan` tool's args into a bounded task list — the SINGLE parser the TUI reducer and
 *  the resume projector both use, so a reloaded plan can never diverge from the one shown live. */
export function parsePlanTasks(args: unknown): PlanTask[] | null {
  const tasks = (args as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return null;
  const out: PlanTask[] = [];
  for (const t of tasks.slice(0, 50)) {
    const text = (t as { text?: unknown })?.text;
    const status = (t as { status?: unknown })?.status;
    if (typeof text !== "string" || text.length === 0) continue;
    const s = status === "active" || status === "done" ? status : "pending";
    // One-line label: also stops a model-authored step (possibly seeded by repo content) smuggling
    // multi-line instructions into a later re-injected prompt.
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length === 0) continue;
    out.push({ text: clean.length > 200 ? `${clean.slice(0, 199)}…` : clean, status: s });
  }
  return out;
}

/** The LATEST plan the model declared (the last `plan` call wins), or [] if none. */
export function latestPlan(events: Event[]): PlanTask[] {
  let latest: PlanTask[] = [];
  for (const ev of events) {
    if (ev.kind === "tool.proposed" && ev.toolName === "plan") {
      const parsed = parsePlanTasks(ev.args);
      if (parsed) latest = parsed;
    }
  }
  return latest;
}

/** The user's CURRENT north-star goal (the last `goal.set` wins), or undefined. An empty string is a CLEAR,
 *  so it resolves to undefined — resuming a cleared session carries no goal. */
export function latestGoal(events: Event[]): string | undefined {
  let latest: string | undefined;
  for (const ev of events) {
    if (ev.kind === "goal.set") latest = ev.text.trim() ? ev.text : undefined;
  }
  return latest;
}

export interface UnsettledTool {
  toolCallId: string;
  toolName: string;
  turnId?: string;
  attemptId?: string;
  proposedArgs?: unknown;
  rawArgs?: string;
}

/**
 * Tools whose intent (tool.started) was recorded but whose settlement (tool.result) never landed — a crash
 * mid-tool, or a torn tail that dropped the result line. Their workspace effect is UNKNOWN.
 */
export function unsettledTools(events: Event[]): UnsettledTool[] {
  const proposed = new Map<string, { args: unknown; rawArgs: string }>();
  const started = new Map<string, UnsettledTool>();
  const settled = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "tool.proposed") {
      proposed.set(ev.toolCallId, { args: ev.args, rawArgs: ev.rawArgs });
    } else if (ev.kind === "tool.started") {
      const p = proposed.get(ev.toolCallId);
      started.set(ev.toolCallId, {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        ...("turnId" in ev && ev.turnId ? { turnId: ev.turnId } : {}),
        ...("attemptId" in ev && ev.attemptId ? { attemptId: ev.attemptId } : {}),
        ...(p ? { proposedArgs: p.args, rawArgs: p.rawArgs } : {}),
      });
    } else if (ev.kind === "tool.result") {
      settled.add(ev.toolCallId);
    }
  }
  return [...started.values()].filter((t) => !settled.has(t.toolCallId));
}

/** A tool's recovery-relevant class, looked up from the registry at the CLI edge (keeps sessions dep-free). */
export interface ToolClass {
  effects: readonly string[];
  idempotency?: string;
}

export interface Reconciliation {
  toolCallId: string;
  toolName: string;
  /** abort = no verifiable/safe recovery, tell the model it was interrupted; inspect = compare fs to expected. */
  action: "abort" | "inspect";
  /** For an `inspect` write: the file path + the sha256 of the INTENDED content (compare to the on-disk file). */
  path?: string;
  expectedPostimageHash?: string;
  note: string;
}

/**
 * Decide how to reconcile each unsettled tool, keyed off the manifest fields that already exist. NEVER
 * blind-replays (every tool is `resumability:"inspect"`; `edit`/`bash` are non-idempotent):
 *  - read-only tool ⇒ abort (no workspace effect to recover).
 *  - `write` with known content ⇒ inspect (the caller hashes the file: match ⇒ landed; mismatch/absent ⇒ redo).
 *  - `edit`/`bash`/other mutating ⇒ abort + re-verify (opaque or non-idempotent effect).
 */
export function reconcile(
  unsettled: UnsettledTool[],
  lookup: (toolName: string) => ToolClass | undefined,
): Reconciliation[] {
  return unsettled.map((t) => {
    const effects = lookup(t.toolName)?.effects ?? [];
    const readOnly = effects.length > 0 && effects.every((e) => e === "read");
    if (readOnly) {
      return {
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        action: "abort",
        note: `read-only ${t.toolName} was interrupted — no workspace effect`,
      };
    }
    if (t.toolName === "write") {
      const content = (t.proposedArgs as { content?: unknown } | undefined)?.content;
      const path = (t.proposedArgs as { path?: unknown } | undefined)?.path;
      if (typeof content === "string" && typeof path === "string") {
        return {
          toolCallId: t.toolCallId,
          toolName: t.toolName,
          action: "inspect",
          path,
          expectedPostimageHash: contentHash(content),
          note: `write to ${path} was interrupted`,
        };
      }
    }
    return {
      toolCallId: t.toolCallId,
      toolName: t.toolName,
      action: "abort",
      note: `${t.toolName} was interrupted with an unverified effect — re-check before relying on it`,
    };
  });
}

/**
 * Turn reconciliations into human/model-facing notes. `applied(r)` (injected — the CLI does the fs hash
 * compare) answers "did this write's intended content actually land on disk?" for an `inspect` action; an
 * `abort` action just states it was interrupted. Pure + fully testable (no fs here).
 */
export function recoveryNotes(
  reconciliations: Reconciliation[],
  applied: (r: Reconciliation) => boolean,
): string[] {
  return reconciliations.map((r) => {
    if (r.action !== "inspect") return `${r.note}.`;
    return applied(r)
      ? `${r.note} — verified already applied on disk (nothing to redo).`
      : `${r.note} — NOT applied (or since changed); re-do it and re-verify${r.path ? ` ${r.path}` : ""}.`;
  });
}

/** Render the outstanding plan (from `latestPlan`) as a compact block for the resumed run's system prompt. */
export function renderOutstandingPlan(tasks: PlanTask[]): string {
  const pending = tasks.filter((t) => t.status !== "done");
  if (pending.length === 0) return "";
  const mark = (s: PlanTask["status"]) => (s === "active" ? "◐" : s === "done" ? "✓" : "○");
  const lines = tasks.map((t) => `  ${mark(t.status)} ${t.text}`);
  return `## Outstanding plan (from the interrupted session — continue it)\n${lines.join("\n")}`;
}
