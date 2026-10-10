import type { Event } from "@amb/protocol";

export const RECOVERY_LIMITS = { maxEvents: 1000, maxBytes: 8 * 1024 * 1024 } as const;
const MAX_PIN_BYTES = 8 * 1024 * 1024;
/** Retain task/plan/checkpoint and unsettled effects even when their records precede the recent tail. */
export class RecoveryWindow {
  private tail: Array<{ event: Event; bytes: number }> = [];
  private tailBytes = 0;
  private readonly pins = new Map<string, { event: Event; bytes: number }>();
  private pinBytes = 0;
  constructor(private readonly limits: { maxEvents?: number; maxBytes?: number }) {}
  private keep(key: string, event: Event, bytes: number): void {
    const nextBytes = this.pinBytes - (this.pins.get(key)?.bytes ?? 0) + bytes;
    if (nextBytes > MAX_PIN_BYTES || (!this.pins.has(key) && this.pins.size >= 512))
      throw new Error("pending recovery state exceeds safe limits");
    this.pins.set(key, { event, bytes });
    this.pinBytes = nextBytes;
  }
  private drop(key: string): void {
    this.pinBytes -= this.pins.get(key)?.bytes ?? 0;
    this.pins.delete(key);
  }
  add(event: Event, bytes: number): void {
    if (event.kind === "session.resumed") {
      if (event.context) this.keep("checkpoint", event, bytes);
      if (event.plan) this.keep("plan", event, bytes);
    }
    if (event.kind === "session.started") this.keep("session", event, bytes);
    if (event.kind === "session.closed") this.keep("closed", event, bytes);
    if (event.kind === "goal.set") this.keep("goal", event, bytes);
    if (event.kind === "turn.started") {
      this.keep("task", event, bytes);
      for (const id of event.messageIds ?? []) this.drop(`message:${id}`);
    }
    if (event.kind === "turn.finished") this.keep("finished", event, bytes);
    if (event.kind === "context.compacted") this.keep("checkpoint", event, bytes);
    if (event.kind === "tool.proposed") {
      if (event.toolName === "plan") this.keep("plan", event, bytes);
      this.keep(`proposed:${event.toolCallId}`, event, bytes);
    }
    if (event.kind === "tool.started") this.keep(`started:${event.toolCallId}`, event, bytes);
    if (event.kind === "tool.result") {
      this.drop(`proposed:${event.toolCallId}`);
      this.drop(`started:${event.toolCallId}`);
    }
    if (event.kind === "steer.queued") this.keep(`message:${event.messageId}`, event, bytes);
    if (event.kind === "steer" && event.messageId) this.drop(`message:${event.messageId}`);
    if (event.kind === "steer.discarded")
      for (const id of event.messageIds) this.drop(`message:${id}`);
    this.tail = [...this.tail, { event, bytes }];
    this.tailBytes += bytes;
    while (
      this.tail.length > (this.limits.maxEvents ?? RECOVERY_LIMITS.maxEvents) ||
      this.tailBytes > (this.limits.maxBytes ?? RECOVERY_LIMITS.maxBytes)
    ) {
      this.tailBytes -= this.tail[0]?.bytes ?? 0;
      this.tail = this.tail.slice(1);
    }
  }
  events(): Event[] {
    const unique = new Map(
      [...this.pins.values(), ...this.tail].map(({ event }) => [event.seq, event]),
    );
    return [...unique.values()].sort((a, b) => a.seq - b.seq);
  }
}
