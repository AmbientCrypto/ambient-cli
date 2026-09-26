import type { BackgroundTasksPort } from "@amb/protocol";

/** Most background tasks running at once in a session. */
const MAX_RUNNING = 4;

interface Task {
  id: string;
  label: string;
  controller: AbortController;
  done: Promise<void>;
  report?: string;
  reported: boolean;
}

/**
 * Work the agent handed off to run beside it (a wave of background subagents). Each task's report reaches the
 * agent as a message at its next turn boundary; the agent waits for any still running before it gives its
 * final answer, so delegated work is never silently dropped.
 */
export class BackgroundTasks implements BackgroundTasksPort {
  private readonly tasks = new Map<string, Task>();
  private next = 1;

  start(label: string, work: (signal: AbortSignal) => Promise<string>): { id: string } {
    if (this.running() >= MAX_RUNNING) {
      throw new Error(
        `already running ${MAX_RUNNING} background tasks — wait for one to report first`,
      );
    }
    const id = `task${this.next++}`;
    const controller = new AbortController();
    const task: Task = { id, label, controller, reported: false, done: Promise.resolve() };
    task.done = work(controller.signal)
      .then(
        (report) => {
          task.report = report;
        },
        (err: unknown) => {
          task.report = `failed: ${(err as Error).message}`;
        },
      )
      .then(() => undefined);
    this.tasks.set(id, task);
    return { id };
  }

  /** How many are still working. */
  running(): number {
    return [...this.tasks.values()].filter((t) => t.report === undefined).length;
  }

  /** Finished tasks not yet handed to the agent (each is handed over once). */
  takeFinished(): Array<{ id: string; label: string; report: string }> {
    const out: Array<{ id: string; label: string; report: string }> = [];
    for (const t of this.tasks.values()) {
      if (t.report === undefined || t.reported) continue;
      t.reported = true;
      out.push({ id: t.id, label: t.label, report: t.report });
    }
    return out;
  }

  /** Resolves when every running task has finished, or when `signal` aborts. */
  async settled(signal: AbortSignal): Promise<void> {
    const pending = [...this.tasks.values()]
      .filter((t) => t.report === undefined)
      .map((t) => t.done);
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
  }

  /** Stop everything still running (the session is ending). */
  stopAll(): void {
    for (const t of this.tasks.values()) if (t.report === undefined) t.controller.abort();
  }
}
