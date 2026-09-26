import { AmbError } from "@amb/protocol";
import type { StreamTimeouts } from "@amb/reliability";

/**
 * Bounds a streaming request with two clocks (first byte, then idle-between-bytes). It owns an internal
 * AbortController linked to the caller's signal: when a clock fires it aborts the request and remembers WHY,
 * so the caller can report a retryable "stalled" transport error instead of a generic abort. A user abort is
 * passed through untouched (never reported as a stall).
 */
/** `AmbError.detail` marker for a stall, so retry policy can fail over sooner than for a network blip. */
export const STALL_DETAIL = "stream-stall";

export class StallWatchdog {
  private readonly ctrl = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private reason: "first" | "idle" | undefined;
  private readonly onUserAbort = () => this.ctrl.abort();

  constructor(
    private readonly t: StreamTimeouts,
    private readonly user?: AbortSignal,
  ) {
    if (user?.aborted) this.ctrl.abort();
    else user?.addEventListener("abort", this.onUserAbort, { once: true });
    this.arm(t.firstByteMs, "first");
  }

  get signal(): AbortSignal {
    return this.ctrl.signal;
  }

  /** True when a watchdog clock (not the user) ended the request. */
  get stalled(): boolean {
    return this.reason !== undefined;
  }

  /** Call on every body chunk: the first switches to the idle clock; each one resets it. */
  alive(): void {
    this.started = true;
    this.arm(this.t.idleMs, "idle");
  }

  error(model: string): AmbError {
    const secs = Math.round((this.reason === "first" ? this.t.firstByteMs : this.t.idleMs) / 1000);
    const message =
      this.reason === "first"
        ? `No response from ${model} after ${secs}s — the worker didn't start streaming.`
        : `${model} stalled — no data for ${secs}s mid-stream.`;
    return new AmbError({
      kind: "transport",
      message,
      retryable: true,
      model,
      detail: STALL_DETAIL,
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.user?.removeEventListener("abort", this.onUserAbort);
  }

  private arm(ms: number, reason: "first" | "idle"): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.user?.aborted) return;
      this.reason = this.started ? "idle" : reason;
      this.ctrl.abort();
    }, ms);
  }
}
