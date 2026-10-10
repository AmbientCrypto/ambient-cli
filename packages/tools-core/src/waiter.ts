export type WaitReason = "output" | "exit" | "steered" | "cancelled" | "timeout";
export interface WaitOptions {
  signal: AbortSignal;
  wakeSignal?: AbortSignal;
  timeoutMs?: number;
}

/** Subscribe first, then recheck: output/close cannot be missed between inspection and sleeping. */
export function waitForCondition(
  subscribe: (check: () => void) => () => void,
  ready: () => "output" | "exit" | undefined,
  opts: WaitOptions,
): Promise<WaitReason> {
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    return Promise.reject(new Error("wait timeout must be positive"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reason: WaitReason, error?: unknown) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", cancel);
      opts.wakeSignal?.removeEventListener("abort", steer);
      if (error !== undefined) reject(error);
      else resolve(reason);
    };
    const cancel = () => finish("cancelled");
    const steer = () => finish("steered");
    const check = () => {
      if (opts.signal.aborted) return cancel();
      if (opts.wakeSignal?.aborted) return steer();
      try {
        const reason = ready();
        if (reason) finish(reason);
      } catch (error) {
        finish("cancelled", error);
      }
    };
    try {
      unsubscribe = subscribe(check);
    } catch (error) {
      finish("cancelled", error);
      return;
    }
    if (settled) {
      unsubscribe();
      return;
    }
    opts.signal.addEventListener("abort", cancel, { once: true });
    opts.wakeSignal?.addEventListener("abort", steer, { once: true });
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => finish("timeout"), opts.timeoutMs);
    check();
  });
}
