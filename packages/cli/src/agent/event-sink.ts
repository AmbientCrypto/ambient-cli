import type { NewEvent } from "@amb/protocol";
import type { SessionWriter } from "@amb/sessions";

/**
 * One durable-event pipeline shared by every command (run / resume / TUI). It persists each event FIRST — the
 * SessionWriter validates durable events against the wire schema before writing — and only THEN delivers it to
 * the UI consumer. So a malformed event can never reach the UI as if it were logged, and a persistence failure
 * is handled ONE way everywhere (onWriteError → the caller aborts + surfaces it) instead of three subtly
 * different ways. Transient events (deltas) are no-ops in the writer and flow straight to the consumer.
 */
export function createDurableEventSink(opts: {
  writer: SessionWriter;
  consume: (ev: NewEvent) => void;
  onWriteError: (err: Error) => void;
}): (ev: NewEvent) => void {
  return (ev: NewEvent) => {
    try {
      opts.writer.append(ev);
    } catch (err) {
      opts.onWriteError(err instanceof Error ? err : new Error(String(err)));
      return; // don't deliver an event we couldn't durably record
    }
    opts.consume(ev);
  };
}
