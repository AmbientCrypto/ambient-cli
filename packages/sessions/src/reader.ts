import { existsSync } from "node:fs";
import { type Event, EventSchema } from "@amb/protocol";
import { eventChecksum } from "./checksum.js";
import { journalLines } from "./journal-lines.js";
import { sessionPath } from "./paths.js";
import { RecoveryWindow } from "./recovery-window.js";

export interface ReadResult {
  events: Event[];
  /** Number of trailing lines that failed to parse (e.g. a torn last line after a crash). */
  droppedTail: number;
  /** True if the prevChecksum hash chain + sequence monotonicity are intact across all parsed events. */
  chainIntact: boolean;
  /** True if any INTERIOR (non-final) line failed to parse — a corrupted middle, not just a torn tail. */
  interiorCorruption: boolean;
  error?: string;
}

/**
 * Read + validate a session log. Only a torn FINAL line (crash during append) is tolerated; a malformed
 * interior line is flagged as corruption. Verifies the prevChecksum chain, each record's own
 * checksum, and strict sequence monotonicity, so tampering / missing / inserted records are caught.
 */
export function readSession(
  sessionId: string,
  env?: Record<string, string | undefined>,
  limits?: { maxEvents?: number; maxBytes?: number },
): ReadResult {
  const path = sessionPath(sessionId, env);
  if (!existsSync(path))
    return { events: [], droppedTail: 0, chainIntact: true, interiorCorruption: false };
  const events: Event[] = [];
  const window = limits ? new RecoveryWindow(limits) : undefined;
  let droppedTail = 0;
  let interiorCorruption = false;
  let chainIntact = true;
  let prev: string | undefined;
  let expectedSeq = 0;
  try {
    for (const line of journalLines(path)) {
      if (droppedTail) {
        interiorCorruption = true;
        droppedTail = 0;
      }
      let ev: Event;
      try {
        ev = EventSchema.parse(JSON.parse(line));
      } catch {
        droppedTail = 1;
        continue;
      }
      if (ev.prevChecksum !== prev || ev.seq !== expectedSeq) chainIntact = false;
      const { checksum, ...rest } = ev;
      if (checksum !== eventChecksum(rest as Omit<Event, "checksum">)) chainIntact = false;
      prev = ev.checksum;
      expectedSeq += 1;
      if (window) window.add(ev, Buffer.byteLength(line));
      else events.push(ev);
    }
  } catch (error) {
    return {
      events: [],
      droppedTail,
      chainIntact: false,
      interiorCorruption: true,
      error: (error as Error).message,
    };
  }
  return {
    events: window?.events() ?? events,
    droppedTail,
    chainIntact: chainIntact && !interiorCorruption,
    interiorCorruption,
  };
}

/** Accepted but not delivered/discarded messages; old logs simply have no receipts. */
export function pendingMessages(events: Event[]): Array<Extract<Event, { kind: "steer.queued" }>> {
  const pending = new Map<string, Extract<Event, { kind: "steer.queued" }>>();
  for (const event of events) {
    if (event.kind === "steer.queued") pending.set(event.messageId, event);
    if (event.kind === "steer" && event.messageId) pending.delete(event.messageId);
    if (event.kind === "turn.started") for (const id of event.messageIds ?? []) pending.delete(id);
    if (event.kind === "steer.discarded") for (const id of event.messageIds) pending.delete(id);
  }
  return [...pending.values()];
}

/** Reconstruct the plain assistant/tool transcript text from a session's durable events. */
export function transcriptText(events: Event[]): string {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.kind === "turn.started") out.push(`> ${ev.input}`);
    else if (ev.kind === "assistant.final") out.push(ev.text);
    else if (ev.kind === "tool.result")
      out.push(`[tool ${ev.toolCallId} ${ev.ok ? "ok" : "error"}]`);
  }
  return out.join("\n");
}

/** Number of turns (user prompts) recorded in a session. */
export function turnCount(events: Event[]): number {
  return events.filter((e) => e.kind === "turn.started").length;
}

/**
 * Reconstruct a readable TEXT transcript of a prior session for warm-continue resume, grouped BY TURN
 * (so interleaved turns can never mis-associate a request with another turn's answer). Injected into the
 * resuming run's SYSTEM prompt (not as chat messages) so it never displaces the compaction goal anchor.
 * Tool results are preview-only in the durable log, so this is a faithful summary, not a byte-exact replay.
 */
export function reconstructTranscript(
  events: Event[],
  /** Applied to each tool result: they can carry someone else's text (a web page, an MCP server). */
  guard: (toolResult: string) => string = (t) => t,
): string {
  // Group events by turn, preserving first-seen turn order.
  const order: string[] = [];
  const byTurn = new Map<string, Event[]>();
  for (const ev of events) {
    const turnId = "turnId" in ev && ev.turnId ? ev.turnId : "__session__";
    if (!byTurn.has(turnId)) {
      byTurn.set(turnId, []);
      if (turnId !== "__session__") order.push(turnId);
    }
    byTurn.get(turnId)?.push(ev);
  }

  const blocks: string[] = [];
  for (const turnId of order) {
    const evs = byTurn.get(turnId) ?? [];
    const toolNames = new Map<string, string>();
    const lines: string[] = [];
    for (const ev of evs) {
      switch (ev.kind) {
        case "turn.started":
          lines.push(`User: ${ev.input}`);
          break;
        case "steer":
          // A mid-run redirect the user injected — part of the conversation, so a resumed/continued session
          // sees it (the event schema promises "a resumed session reconstructs the full conversation").
          lines.push(`User (mid-run): ${ev.text}`);
          break;
        case "tool.proposed":
          toolNames.set(ev.toolCallId, ev.toolName);
          lines.push(`  → called ${ev.toolName} ${ev.rawArgs}`);
          break;
        case "tool.result": {
          const name = toolNames.get(ev.toolCallId) ?? "tool";
          const body = ev.ok ? (ev.preview ?? "(ok)") : `ERROR: ${ev.error ?? "failed"}`;
          lines.push(`  ← ${name} result: ${guard(body)}`);
          break;
        }
        case "assistant.final":
          if (ev.text.trim()) lines.push(`Assistant: ${ev.text.trim()}`);
          break;
        default:
          break;
      }
    }
    if (lines.length > 0) blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
