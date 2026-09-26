import { type ChildProcess, spawn } from "node:child_process";
import { killProcessTree, machineShell, shellEnv, shellInvocation } from "./shell.js";
import { cleanTerminalOutput } from "./tools/bash.js";

/**
 * Shell commands running in the background for a session (a dev server, a watcher, a long build): started by
 * `bash` with `background: true`, read with `bash_output`, stopped with `kill_shell`. Each job keeps its most
 * recent output (bounded), and every job is stopped when the session ends.
 */

/** Output kept per job; older output is dropped from the front. */
const MAX_JOB_OUTPUT_CHARS = 1_000_000;
const MAX_JOBS = 16;
/** Finished jobs kept for reading (older ones already read are let go, with their output). */
const MAX_FINISHED_KEPT = 16;

export interface BackgroundJob {
  id: string;
  command: string;
  startedAt: number;
  /** Exit code once it has finished (null for a signal); undefined while running. */
  exitCode?: number | null;
  finishedAt?: number;
}

interface JobState extends BackgroundJob {
  child: ChildProcess;
  output: string;
  /** Total characters ever received — offsets into the output survive dropping old output. */
  received: number;
  /** Where the model last read up to. */
  readTo: number;
  /** Whether the model has been told this job finished. */
  reported: boolean;
}

export interface JobOutput {
  id: string;
  command: string;
  running: boolean;
  exitCode?: number | null;
  /** Output received since the last read (or since `since`). */
  output: string;
  /** Some output in between was dropped because the job produced more than is kept. */
  truncated: boolean;
}

export class BackgroundJobs {
  private readonly jobs = new Map<string, JobState>();
  private next = 1;
  private readonly listeners = new Set<(job: BackgroundJob) => void>();

  /** Start a command; its output collects until read. */
  start(command: string, cwd: string): BackgroundJob {
    if ([...this.jobs.values()].filter((j) => j.exitCode === undefined).length >= MAX_JOBS) {
      throw new Error(
        `already running ${MAX_JOBS} background commands — stop one with kill_shell first`,
      );
    }
    const shell = machineShell();
    const child = spawn(shell.path, shellInvocation(shell, command), {
      cwd,
      env: shellEnv(shell),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.prune();
    const id = `bg${this.next++}`;
    const job: JobState = {
      id,
      command,
      startedAt: Date.now(),
      child,
      output: "",
      received: 0,
      readTo: 0,
      reported: false,
    };
    const append = (d: Buffer) => {
      const text = d.toString("utf8");
      job.output += text;
      job.received += text.length;
      if (job.output.length > MAX_JOB_OUTPUT_CHARS)
        job.output = job.output.slice(-MAX_JOB_OUTPUT_CHARS);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      append(Buffer.from(`\n[could not start: ${err.message}]\n`));
      this.finish(job, null);
    });
    child.on("exit", (code) => this.finish(job, code));
    this.jobs.set(id, job);
    return this.view(job);
  }

  private finish(job: JobState, code: number | null): void {
    if (job.exitCode !== undefined) return;
    job.exitCode = code;
    job.finishedAt = Date.now();
    for (const l of this.listeners) l(this.view(job));
  }

  private view(job: JobState): BackgroundJob {
    return {
      id: job.id,
      command: job.command,
      startedAt: job.startedAt,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    };
  }

  /** Let go of the oldest finished jobs whose end the agent has already seen. */
  private prune(): void {
    const done = [...this.jobs.values()].filter((j) => j.exitCode !== undefined && j.reported);
    for (const j of done.slice(0, Math.max(0, done.length - MAX_FINISHED_KEPT)))
      this.jobs.delete(j.id);
  }

  /** New output since the last read (the model reads a job incrementally). */
  read(id: string): JobOutput {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no background command ${id} (running: ${this.idsText()})`);
    const firstKept = job.received - job.output.length;
    const from = Math.max(job.readTo, firstKept);
    const text = job.output.slice(from - firstKept);
    const truncated = job.readTo < firstKept;
    job.readTo = job.received;
    if (job.exitCode !== undefined) job.reported = true;
    return {
      id,
      command: job.command,
      running: job.exitCode === undefined,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      output: cleanTerminalOutput(text),
      truncated,
    };
  }

  /** Stop a job and everything it started. */
  kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.exitCode !== undefined) return false;
    if (typeof job.child.pid === "number") killProcessTree(job.child.pid);
    else job.child.kill("SIGKILL");
    return true;
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()].map((j) => this.view(j));
  }

  /** Jobs that finished since the model last heard about them (each is reported once). */
  takeFinished(): BackgroundJob[] {
    const out: BackgroundJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.exitCode !== undefined && !job.reported) {
        job.reported = true;
        out.push(this.view(job));
      }
    }
    return out;
  }

  /** Called whenever a job finishes (for the UI). */
  onFinish(cb: (job: BackgroundJob) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Stop every running job (the session is ending). */
  stopAll(): void {
    for (const job of this.jobs.values()) {
      if (job.exitCode === undefined) this.kill(job.id);
    }
  }

  private idsText(): string {
    const running = [...this.jobs.values()]
      .filter((j) => j.exitCode === undefined)
      .map((j) => j.id);
    return running.length > 0 ? running.join(", ") : "none";
  }
}
