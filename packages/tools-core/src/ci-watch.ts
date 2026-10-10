import {
  CI_LOG_LIMIT,
  CI_POLL_DELAYS,
  CiResult,
  CiSnapshot,
  CiTarget,
  FAILED_CONCLUSIONS,
} from "./ci-schema.js";
import { type CiReader, GithubCiReader } from "./github-ci.js";
import { type WaitOptions, waitForCondition } from "./waiter.js";

const MAX_WATCHES = 16;
const MAX_ERRORS = 3;
interface Watch {
  target: CiTarget;
  controller: AbortController;
  snapshot?: CiSnapshot;
  error?: string;
  failures: number[];
  reported: number[];
  completedReported: boolean;
  notified?: number[];
  delay: number;
  errors: number;
  timer?: ReturnType<typeof setTimeout>;
  progress?: (summary: string, active: boolean) => void;
}

/** One monitor per run, independent of tool waits: diagnosing a failure does not stop other jobs. */
export class CiWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly changes = new Set<() => void>();
  constructor(
    private readonly reader: CiReader = new GithubCiReader(),
    private readonly delays: readonly number[] = CI_POLL_DELAYS,
  ) {}

  private ensure(target: CiTarget, progress?: Watch["progress"]): string {
    const key = `${target.repo}:${target.runId}`;
    const existing = this.watches.get(key);
    if (existing) {
      this.watches.set(key, { ...existing, progress: progress ?? existing.progress });
      return key;
    }
    for (const [id, watch] of this.watches) {
      if (this.watches.size < MAX_WATCHES) break;
      if (watch.snapshot?.status === "completed" || watch.error) this.watches.delete(id);
    }
    if (this.watches.size >= MAX_WATCHES)
      throw new Error(`already monitoring ${MAX_WATCHES} CI runs`);
    this.watches.set(key, {
      target,
      controller: new AbortController(),
      failures: [],
      reported: [],
      completedReported: false,
      delay: 0,
      errors: 0,
      progress,
    });
    void this.poll(key);
    return key;
  }

  private publish(key: string, watch: Watch): void {
    this.watches.set(key, watch);
    for (const change of this.changes) change();
    const finished = watch.snapshot?.jobs.filter((job) => job.status === "completed").length ?? 0;
    const summary = `${watch.target.repo} #${watch.target.runId}: ${finished}/${watch.snapshot?.jobs.length ?? 0} jobs completed · ${watch.error || watch.snapshot?.conclusion || watch.snapshot?.status || "waiting"}`;
    watch.progress?.(summary, !watch.error && watch.snapshot?.status !== "completed");
  }

  private schedule(key: string): void {
    const watch = this.watches.get(key);
    if (
      !watch ||
      watch.controller.signal.aborted ||
      watch.error ||
      watch.snapshot?.status === "completed"
    )
      return;
    const timer = setTimeout(() => void this.poll(key), this.delays[watch.delay] ?? 60_000);
    this.watches.set(key, { ...watch, timer });
  }

  private async poll(key: string): Promise<void> {
    const initial = this.watches.get(key);
    if (!initial || initial.controller.signal.aborted) return;
    try {
      const snapshot = CiSnapshot.parse(
        await this.reader.read(initial.target, initial.controller.signal),
      );
      const current = this.watches.get(key);
      if (!current || current.controller.signal.aborted) return;
      const changed = JSON.stringify(snapshot) !== JSON.stringify(current.snapshot);
      const failures = snapshot.jobs
        .filter(
          (job) =>
            FAILED_CONCLUSIONS.has(job.conclusion ?? "") &&
            !current.reported.includes(job.databaseId),
        )
        .map((job) => job.databaseId);
      const next = {
        ...current,
        snapshot,
        failures,
        errors: 0,
        delay: changed ? 0 : Math.min(current.delay + 1, this.delays.length - 1),
      };
      if (changed) this.publish(key, next);
      else this.watches.set(key, next);
    } catch (error) {
      const current = this.watches.get(key);
      if (!current || current.controller.signal.aborted) return;
      const message = (error as Error).message;
      const terminal =
        /auth login|authentication|HTTP 401|not found|unavailable:|safe size|invalid|JSON/i.test(
          message,
        );
      const errors = current.errors + 1;
      this.publish(key, {
        ...current,
        errors,
        delay: Math.min(current.delay + 1, this.delays.length - 1),
        ...(terminal || errors >= MAX_ERRORS ? { error: message } : {}),
      });
    }
    this.schedule(key);
  }

  async wait(
    input: CiTarget,
    opts: WaitOptions & { progress?: Watch["progress"] },
  ): Promise<CiResult> {
    const target = CiTarget.parse(input);
    const key = this.ensure(target, opts.progress);
    const watch = this.watches.get(key) as Watch;
    const signal = AbortSignal.any([opts.signal, watch.controller.signal]);
    const interrupted = await waitForCondition(
      (check) => {
        this.changes.add(check);
        return () => {
          this.changes.delete(check);
        };
      },
      () => {
        const current = this.watches.get(key);
        return current?.error ||
          current?.failures.length ||
          current?.snapshot?.status === "completed"
          ? "exit"
          : undefined;
      },
      { ...opts, signal },
    );
    const current = this.watches.get(key) ?? watch;
    const failedJobs =
      current.snapshot?.jobs.filter((job) => current.failures.includes(job.databaseId)) ?? [];
    const reason =
      interrupted !== "exit"
        ? interrupted
        : current.error
          ? "error"
          : failedJobs.length
            ? "failure"
            : "complete";
    let logs = "";
    if (reason === "failure") {
      this.watches.set(key, {
        ...current,
        reported: [...current.reported, ...current.failures],
        failures: [],
      });
      const logSignal = AbortSignal.any([signal, ...(opts.wakeSignal ? [opts.wakeSignal] : [])]);
      try {
        logs = (await this.reader.logs(target, failedJobs[0]?.databaseId ?? 0, logSignal)).slice(
          -CI_LOG_LIMIT,
        );
      } catch (error) {
        logs = `Logs unavailable: ${(error as Error).message}`;
      }
    }
    return CiResult.parse({
      ...target,
      reason,
      running:
        !current.error &&
        current.snapshot?.status !== "completed" &&
        !watch.controller.signal.aborted,
      ...(current.snapshot ? { snapshot: current.snapshot } : {}),
      failedJobs,
      logs,
      ...(current.error ? { error: current.error } : {}),
    });
  }

  takeUpdates(): string[] {
    let updates: string[] = [];
    for (const [key, watch] of this.watches) {
      const fresh = watch.failures.filter((id) => !watch.notified?.includes(id));
      if (fresh.length || (watch.snapshot?.status === "completed" && !watch.completedReported)) {
        updates = [
          ...updates,
          `CI ${key}: ${fresh.length ? `new failed jobs ${fresh.join(", ")}` : "completed"}; ${watch.snapshot?.conclusion || watch.snapshot?.status}. Use watch_ci for details.`,
        ];
        this.watches.set(key, {
          ...watch,
          notified: [...(watch.notified ?? []), ...fresh],
          completedReported: watch.snapshot?.status === "completed",
        });
      }
    }
    return updates;
  }

  isActive(target: { repo: string; runId: number }): boolean {
    const watch = this.watches.get(`${target.repo}:${target.runId}`);
    return (
      !!watch &&
      !watch.controller.signal.aborted &&
      !watch.error &&
      watch.snapshot?.status !== "completed"
    );
  }

  stopAll(): void {
    for (const watch of this.watches.values()) {
      clearTimeout(watch.timer);
      watch.controller.abort();
    }
    this.watches.clear();
    this.changes.clear();
  }
}
