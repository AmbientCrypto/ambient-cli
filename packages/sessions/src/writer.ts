import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { type Event, EventSchema, type NewEvent, newEventId } from "@amb/protocol";
import { eventChecksum } from "./checksum.js";
import { sessionPath } from "./paths.js";

export type { NewEvent };

/** Event kinds that are transient UI signals and must NOT be persisted (bloat + no-hidden-reasoning). */
const TRANSIENT = new Set<Event["kind"]>([
  "assistant.delta",
  "reasoning.delta",
  "subagent.delta",
  "tool.drafting",
]);

/**
 * Append-only session writer. Single writer per session file. Each durable event is validated,
 * stamped (eventId/seq/ts), chained (prevChecksum → checksum), and appended with O_APPEND + fsync so a
 * crash can never leave a torn record ahead of a synced one. Transient events are dropped, not written.
 */
export class SessionWriter {
  private seq = 0;
  private prevChecksum: string | undefined;
  private readonly path: string;
  private opened = false;

  constructor(
    private readonly sessionId: string,
    private readonly now: () => string,
    env?: Record<string, string | undefined>,
    startSeq = 0,
    startPrevChecksum?: string,
  ) {
    this.path = sessionPath(sessionId, env);
    this.seq = startSeq;
    this.prevChecksum = startPrevChecksum;
  }

  private ensureDir(): void {
    if (!this.opened) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.opened = true;
    }
  }

  /** Append a durable event. Returns the fully-stamped event, or null if it was transient. */
  append(ev: NewEvent): Event | null {
    if (TRANSIENT.has(ev.kind)) return null;
    this.ensureDir();
    const base = {
      ...ev,
      eventId: newEventId(),
      seq: this.seq,
      ts: this.now(),
      ...(this.prevChecksum !== undefined ? { prevChecksum: this.prevChecksum } : {}),
    } as Omit<Event, "checksum">;
    const checksum = eventChecksum(base);
    const full = { ...base, checksum } as Event;
    // Validate before writing — a malformed event must never enter the durable log.
    EventSchema.parse(full);

    const fd = openSync(this.path, "a");
    try {
      // Write ALL bytes — writeSync can perform a short write; loop until the whole record lands.
      const buf = Buffer.from(`${JSON.stringify(full)}\n`, "utf8");
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written);
      }
      // Advance state only after the full record is written: once it is on the append stream it is part
      // of the chain, so a later fsync failure must NOT desync seq/prevChecksum.
      this.seq += 1;
      this.prevChecksum = checksum;
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return full;
  }
}
