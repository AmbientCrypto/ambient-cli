import { z } from "zod";
import type { NewEvent } from "./event.js";

/** The classes of side effect a tool can have. Drives permissions + safe-parallelism. */
export const EffectSchema = z.enum(["read", "write", "process", "network", "secret"]);
export type Effect = z.infer<typeof EffectSchema>;

export const IdempotencySchema = z.enum(["pure", "idempotent", "non-idempotent"]);
export type Idempotency = z.infer<typeof IdempotencySchema>;

export const ResumabilitySchema = z.enum(["replay", "inspect", "never-replay"]);
export type Resumability = z.infer<typeof ResumabilitySchema>;

/** Serializable tool metadata — safe to log, send to a model, or persist. */
export const ToolManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().default("1"),
  description: z.string(),
  effects: z.array(EffectSchema).default([]),
  idempotency: IdempotencySchema.default("non-idempotent"),
  parallelSafe: z.boolean().default(false),
  resumability: ResumabilitySchema.default("inspect"),
  timeoutPolicy: z.object({
    idleMs: z.number().int().positive(),
    maximumMs: z.number().int().positive().optional(),
  }),
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/** A tool is read-only iff it has effects and every one of them is "read". */
export function isReadOnly(m: ToolManifest): boolean {
  return m.effects.length > 0 && m.effects.every((e) => e === "read");
}

/** One selectable choice in an `ask_user` question — a short label plus an optional one-line description. */
export interface AskOption {
  label: string;
  description?: string;
}
/** A structured question the agent pushes to the human (backs the `ask_user` tool). */
export interface AskRequest {
  question: string;
  /** Selectable choices; when present the human picks one (or several, if `multiSelect`). */
  options?: AskOption[];
  /** Allow free-text context in addition to / instead of a choice (default true). */
  allowText?: boolean;
  /** Allow selecting more than one option. */
  multiSelect?: boolean;
}
/** The human's answer to an `ask_user` question. */
export interface AskResponse {
  /** Labels the human selected (empty if they only typed text or cancelled). */
  selected: string[];
  /** Free-text the human added, if any. */
  text?: string;
  /** True when the human dismissed the question without answering (Esc) — the agent should proceed. */
  cancelled?: boolean;
}

export interface ToolContext {
  cwd: string;
  workspaceRoot: string;
  signal: AbortSignal;
  /** Resolve a secret by opaque reference — the value never enters model context. */
  secret(ref: string): Promise<string>;
  emit(event: NewEvent): void;
  /** Save a file's pre-image content to the session blob store before overwriting it (enables `amb rewind`).
   *  Optional — absent ⇒ no checkpointing (the mutation still records its preimageHash in the event log). */
  checkpoint?(content: string): void;
  /** The attempt this tool call belongs to — lets a tool author correlated events (e.g. a subagent tool
   *  emitting subagent.* onto the parent stream). Optional so builtins + the inert test ctx ignore it. */
  scope?: { sessionId: string; turnId: string; attemptId: string };
  /** The parent tool-call id (tc_…) this ctx is executing, for correlating nested events back to the call. */
  toolCallId?: string;
  /** Read a previously-offloaded artifact (a large tool output) by its handle, or undefined if unavailable.
   *  Backs the `read_artifact` tool — large outputs are stored whole and retrieved on demand instead of being
   *  lossily truncated (Karpathy: keep-and-offload beats summarize). Optional — absent ⇒ no artifact store. */
  readArtifact?(handle: string): string | undefined;
  /** Ask the human a structured question (options + optional free-text) and await their answer. Backs the
   *  `ask_user` tool. Optional — absent ⇒ no interactive human (headless / subagent child), so the tool
   *  returns a proceed-with-best-judgment note rather than blocking forever. */
  ask?(req: AskRequest): Promise<AskResponse>;
  /** Characters of this call's result that fit in the caller's context right now (from the served model's
   *  window). Lets a tool that gathers a lot (a subagent wave) share that room fairly. Optional. */
  resultChars?: number;
  /** Folders outside the workspace this run may READ (a loaded skill's own files — scripts/, references/).
   *  `add` grants one for the rest of the run. Optional — absent ⇒ reads stay inside the workspace. */
  readRoots?: { list(): readonly string[]; add(dir: string): void };
  /** Whether your deny rules keep this absolute path from being read — tools that walk folders skip such
   *  files, and `read` refuses them. Optional — absent ⇒ no read rules. */
  readDenied?(absPath: string): boolean;
  /** The session's background shell commands (`bash` with `background: true`). Optional — absent ⇒ none. */
  backgroundJobs?: BackgroundJobsPort;
  /** Work that runs beside the agent and reports back at a turn boundary. Absent ⇒ not available. */
  backgroundTasks?: BackgroundTasksPort;
}

/** Hand work off to run in the background; its report reaches the agent when it's done. */
export interface BackgroundTasksPort {
  start(label: string, work: (signal: AbortSignal) => Promise<string>): { id: string };
}

/** Background shell commands for a session: start one, read its new output, stop it, list them. */
export interface BackgroundJobsPort {
  start(command: string, cwd: string): { id: string };
  read(id: string): {
    id: string;
    command: string;
    running: boolean;
    exitCode?: number | null;
    output: string;
    truncated: boolean;
  };
  kill(id: string): boolean;
  list(): Array<{ id: string; command: string; exitCode?: number | null }>;
}

/** A tool = serializable manifest + Zod I/O schemas + an execute fn. Not fully serializable (has execute). */
export interface ToolDefinition<I = unknown, O = unknown> {
  manifest: ToolManifest;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  execute(input: I, ctx: ToolContext): Promise<O>;
}
