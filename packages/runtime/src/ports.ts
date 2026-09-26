import type { SkillMeta } from "@amb/context";
import type { PermissionRules } from "@amb/permissions";
import type {
  AskRequest,
  AskResponse,
  CatalogModel,
  Grant,
  ImageAttachment,
  Lane,
  Mode,
  NewEvent,
  PermissionDecision,
} from "@amb/protocol";
import type { RoutedRole } from "@amb/reliability";

/**
 * The runtime's view of capability evidence (implemented by the CLI over @amb/capabilities). Lets the
 * agent pick the honest lane per model and learn from real runs. Optional — absent ⇒ default behavior
 * (assume `direct`, no learning).
 */
export interface CapabilityPort {
  laneFor(model: CatalogModel): Lane;
  /** Record that a model did (or did not) emit well-formed native tool calls in a real run. */
  learn(modelId: string, toolCallingWorked: boolean): void;
  /** The learned REAL context ceiling (tokens) for a model, if we've seen it overflow (catalog-adaptive). */
  learnedCeiling?(modelId: string): number | undefined;
  /** Learn a model's real ceiling from a provider overflow — only ever LOWERS the optimistic catalog window. */
  learnCeiling?(modelId: string, observedMax: number): void;
  /** Record one verify-gate outcome (its earned-autonomy signal): did this model pass on the first try? */
  recordVerify?(modelId: string, firstTryPass: boolean): void;
  /** The model's persisted verify track record (runs + first-try passes), for earned-autonomy scaling. */
  verifyStats?(modelId: string): { runs: number; firstTryPasses: number } | undefined;
  /** The learned bytes-per-token for a model (calibrated from real provider usage), or undefined for the
   *  default estimate. Lets a fleet of models that tokenize code very differently (Qwen/o200k/Llama3) be
   * budgeted accurately instead of a single 3.5 constant. */
  bytesPerToken?(modelId: string): number | undefined;
  /** Calibrate a model's bytes-per-token from an actual (requestBytes / reported promptTokens) observation. */
  learnBytesPerToken?(modelId: string, bytesPerToken: number): void;
  /** Record one real request's outcome (success + latency) — steers automatic model choice over time. */
  recordOutcome?(modelId: string, ok: boolean, latencyMs: number): void;
  /** What real traffic taught us about a model, or undefined when nothing is known yet. */
  stats?(modelId: string): { okRate?: number; latencyMs?: number; samples?: number } | undefined;
}

/** One tool call the model asked for. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments (may be `undefined` if the JSON was malformed — the runtime handles that). */
  args: unknown;
  /** Raw argument string as streamed (for error reporting on parse failure). */
  rawArgs: string;
}

/** The settled result of one model turn. */
export interface TurnCompletion {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  reportedModel?: string;
  usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number };
}

/** A single chat message in the transcript we send to the model. */
export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Groups a tool call with its result so compaction never splits them. */
  toolGroupId?: string;
  /** The current run's task message: compaction never summarizes it. Cleared when carried to a later run. */
  pinned?: boolean;
}

/**
 * The workspace's filesystem + environment context, injected so the runtime state machine stays free of
 * direct `fs`/`process`/clock effects (deterministic + replayable; effects live at the CLI edge). Optional —
 * absent ⇒ inert defaults (no instructions, no memory, no date/platform), which is fine for isolated tests.
 */
export interface WorkspaceContextPort {
  /** Concatenated project instruction files (AGENTS.md/CLAUDE.md/…) for `cwd`, or "" if none, bounded by
   *  `limits` (characters; sized from the served model) when given. */
  instructions(cwd: string, limits?: { perFile: number; total: number }): string;
  /** Durable project memory (.ambient/MEMORY.md) for the workspace, or undefined if none. */
  readMemory(workspaceRoot: string): string | undefined;
  /** The user's notes for every project, or undefined if none. */
  readUserMemory?(): string | undefined;
  /** The instruction files (AGENTS.md, CLAUDE.md, …) in exactly this folder, or undefined if none. */
  folderInstructions?(dir: string): string | undefined;
  /** Persist the compounding project memory (best-effort; never load-bearing). */
  writeMemory(workspaceRoot: string, summary: string): void;
  /** Today's date as YYYY-MM-DD (injectable clock). */
  date(): string;
  /** The host platform string (e.g. process.platform). */
  platform(): string;
  /** Discover Agent Skills (SKILL.md catalog) under the workspace — only name+description; body loads on demand. */
  skills(workspaceRoot: string): SkillMeta[];
  /** A compact snapshot of the repo's git state (branch, changed files, recent commits) at run start, or
   *  undefined when `cwd` isn't a git work tree. Injected into the prompt so the agent isn't blind to git
   *  without spending tool calls. Optional — a port that omits it simply contributes no git block. */
  git?(cwd: string): string | undefined;
  /** A ranked, token-budgeted repository map (signatures only) for `tokenBudget` tokens, or "" if none/omitted.
   *  Optional — a port that doesn't provide it simply contributes no map (inert default). */
  repoMap?(workspaceRoot: string, tokenBudget: number): string;
}

/**
 * The user's reasoning-effort choice. `auto` is resolved by the agent per turn from the task, the mode and the
 * run's progress; `off` sends an explicit `none`; `high`/`max` are sent as-is. Nothing is sent to a model that
 * doesn't advertise `reasoning`.
 */
export type EffortSetting = "off" | "auto" | "high" | "max";

/** The reasoning tiers Ambient actually serves (measured): none, high, max. */
export type ReasoningLevel = "none" | "high" | "max";

export interface ChatParams {
  model: string;
  messages: Msg[];
  tools: unknown[];
  maxTokens: number;
  signal: AbortSignal;
  /** Resolved reasoning effort for THIS request, or undefined to omit the param. */
  reasoningEffort?: ReasoningLevel;
  /** True when the outbound messages carry image content-parts — lets the adapter mark the request so an
   *  image-related 400 isn't misread as a context overflow. Absent ⇒ the adapter derives it from `messages`. */
  hasImage?: boolean;
  /** Watchdog budgets for this request (first byte + idle). The adapter aborts a stalled stream with a
   *  retryable transport error so failover takes over. Absent ⇒ unbounded. */
  timeouts?: { firstByteMs: number; idleMs: number };
  onContent?: (t: string) => void;
  onReasoning?: (t: string) => void;
  /** A tool call taking shape mid-stream (its name, then the file it targets). */
  onToolDraft?: (draft: { name: string; path?: string }) => void;
  /** Output the server holds back until complete (a tool call being written), one call per token. */
  onHiddenOutput?: () => void;
}

/**
 * The seam between the runtime and Ambient. The real adapter wraps @amb/ambient-api; tests inject a
 * scripted mock (a replay-harness pattern) so the whole agent loop runs offline + deterministic.
 */
export interface ChatClient {
  /** Fetch the live catalog. Accepts an abort signal so a hung fetch can be cancelled. `fresh` bypasses any
   *  short-lived cache (failover and model switches need the fleet as it is right now). */
  fetchCatalog(signal?: AbortSignal, opts?: { fresh?: boolean }): Promise<CatalogModel[]>;
  chat(params: ChatParams): Promise<TurnCompletion>;
}

/** The outcome of running the project's verification (tests / build / typecheck). */
export interface VerifyOutcome {
  ok: boolean;
  /** On failure, the (already-bounded) diagnostic output fed back to the model. Empty when ok. */
  summary: string;
}

/**
 * Runs the project's verification on demand. Returns null when NO verification is configured (honest — the
 * gate is skipped, never faked). The CLI wraps a user-provided `.ambient/verify` script; tests inject a stub.
 * Receives the run's abort signal so a Ctrl-C mid-verification can kill the script + its process group.
 */
export type VerifyPort = (signal?: AbortSignal) => Promise<VerifyOutcome | null>;

/** How the runtime asks the human to approve a gated tool call (interactive prompt). */
export type Approver = (req: {
  toolName: string;
  args: unknown;
  effects: import("@amb/protocol").Effect[];
  decision: PermissionDecision;
}) => Promise<"allow-once" | "allow-session" | "deny">;

/** How the runtime pushes a structured question to the human and awaits their answer (backs `ask_user`). */
export type AskPort = (req: AskRequest) => Promise<AskResponse>;

export interface RunOptions {
  /** Unique per-run session id (the CLI mints one; the writer chains from seq 0). */
  sessionId: string;
  mode: Mode;
  requestedModel: string;
  /** Turns per SEGMENT before a budget checkpoint. Not a hard cap on its own — `maxAutoContinues` extends the
   *  run in further segments up to `maxTurns * (1 + maxAutoContinues)`. */
  maxTurns: number;
  /** Auto-continue past a segment boundary (compact + keep going, no user action) while the task is making
   *  progress. Default true. Set false for a one-tap manual continue at each checkpoint. */
  autoContinue?: boolean;
  /** How many extra segments auto-continue may add before the hard ceiling. Absent/0 ⇒ no auto-continue (the
   *  run stops at `maxTurns`, the pre-existing behavior — subagents pass nothing, so they are unaffected). */
  maxAutoContinues?: number;
  cwd: string;
  workspaceRoot: string;
  signal: AbortSignal;
  /** Emit an event intent (UI renders these; the writer stamps + persists durable ones). */
  emit: (ev: NewEvent) => void;
  approve: Approver;
  /** Optional interactive-question port (backs `ask_user`). Absent ⇒ no human is reachable (headless run /
   *  subagent child), and the tool returns a proceed-on-best-judgment note instead of blocking. */
  ask?: AskPort;
  /** Optional mid-run STEER port. The agent calls it at each turn boundary; any strings it returns are
   *  injected as new user messages into the RUNNING conversation — the user redirecting the agent without
   *  cancelling. Absent ⇒ no steering. Each call consumes what it returns (the port drains its own queue). */
  steer?: () => string[];
  /** Session-scoped permission grants (mutated in place as the user picks "allow for this session"). Pass a
   *  STABLE array across turns so an allow-session grant actually persists — the TUI holds one per session.
   *  Absent ⇒ a fresh per-run array (grants last one run only). */
  grants?: Grant[];
  /** Images the user attached to THIS run's initiating message. A vision-capable served model sees them
   *  directly; a blind model gets a text description via the vision relay. Absent ⇒ a plain text run. */
  attachments?: readonly import("@amb/protocol").ImageAttachment[];
  /** Optional capability evidence (honest lane + learning). Absent ⇒ assume direct, no learning. */
  capabilities?: CapabilityPort;
  /** Reasoning-effort choice for this run (resolved per-request by the agent). Absent ⇒ "auto". */
  effort?: EffortSetting;
  /** The level the previous run in this session used, so a short "continue" keeps it under `auto`. */
  priorEffort?: ReasoningLevel;
  /** Every image attached in this session so far (numbered from 1, in order) — lets a model that can't see
   *  images ask a vision model about any of them with `ask_vision`. Absent ⇒ just this run's attachments. */
  sessionImages?: readonly ImageAttachment[];
  /** Load (and size) an image file for the conversation — backs the `view_image` tool. Absent ⇒ no tool. */
  loadImage?: (absPath: string) => Promise<ImageAttachment>;
  /** Polled at each turn boundary: a model id the user switched to mid-run (e.g. /model), consumed once. The
   *  switch applies from the next turn and re-fits the conversation to the new model. */
  nextModel?: () => string | undefined;
  /** Polled at each turn boundary: true makes the NEXT turn the final, tool-free wrap-up (e.g. a subagent
   *  past its soft deadline reports what it found instead of being killed mid-work). */
  wrapUp?: () => boolean;
  /** Workspace fs/env context (instructions, memory, clock, platform) — REQUIRED so a run can never silently
   *  lose project instructions/memory. Tests pass an explicit inert or real-fs implementation. */
  workspace: WorkspaceContextPort;
  /** Optional project verification (Karpathy gen→verify). When present and the model finishes after
   *  mutating files, the runtime runs it and re-asks the model on failure. Absent ⇒ no gate. */
  verify?: VerifyPort;
  /** Optional pre-image checkpointer: a mutating tool calls it with a file's prior content before overwriting
   *  so `amb rewind` can restore it. Absent ⇒ no checkpointing. */
  checkpoint?: (content: string) => void;
  /** Optional artifact store: save a large tool output whole, returning a handle. When a tool result
   *  would be truncated to fit the window, the FULL output is offloaded here so the model can retrieve it via
   *  `read_artifact` instead of losing it. Absent ⇒ results are just truncated (no offload). */
  artifact?: (content: string) => string | undefined;
  /** Read a previously-offloaded artifact by handle (backs the read_artifact tool). Absent ⇒ no retrieval. */
  readArtifact?: (handle: string) => string | undefined;
  /**
   * Optional prior-session transcript for warm-continue resume. Injected into the SYSTEM prompt (NOT as
   * chat messages) so it never displaces the compaction goal anchor (system + the new instruction).
   * Used for CROSS-PROCESS resume (`ambient resume`), where no live `Msg[]` exists. Ignored when
   * `priorMessages` is present (the live in-memory conversation is lossless and always preferred).
   */
  resumeContext?: string;
  /**
   * Extra instructions for this run, placed in the system prompt with the highest priority — a subagent
   * preset's own prompt, or text appended with `--append-system-prompt`.
   */
  instructions?: string;
  /** User-configured hooks (scripts run on tool calls, prompts and finishing). Absent ⇒ none. */
  hooks?: HooksPort;
  /** State that outlives one run in an interactive session: folders a loaded skill made readable, and
   *  folders whose instructions were already offered. Absent ⇒ fresh for this run. */
  runState?: import("./execute-tools.js").RunState;
  /** Allow / deny / ask rules (Claude Code syntax) layered over the permission mode. */
  permissionRules?: PermissionRules;
  /**
   * The prior interactive conversation — the non-system messages returned by the LAST `run` in this same
   * live session. When present, the agent continues the REAL message array (`[freshSystem, ...priorMessages,
   * newUser]`) instead of rebuilding context from the lossy `resumeContext` reconstruction. This routes the
   * whole multi-message interactive session through the runtime's own compaction (which keeps full tool
   * bodies + the goal/plan anchor), instead of degrading to 8-line previews between messages. Absent ⇒ a
   * fresh conversation (the first message of a session, or a cross-process resume).
   */
  priorMessages?: readonly Msg[];
  /**
   * The outstanding plan checklist to PIN into the system anchor from turn 1 of this run. Lets a multi-message
   * session keep adhering to the plan even before the model re-calls `plan`, and keeps it visible after
   * compaction summarizes the earlier `plan` tool-calls away. Same `{ tasks }` shape the `plan` tool takes.
   * Absent ⇒ no seeded plan (the model establishes one via the `plan` tool as usual).
   */
  plan?: { tasks: { text: string; status: "pending" | "active" | "done" }[] };
  /**
   * The user's session-long NORTH-STAR objective (set via `/goal`). Baked into the system-prompt anchor at the
   * top of the dynamic block so it stays resident every turn and survives compaction (it never enters the
   * summarizable transcript). Kept tiny; the agent never rewrites it — only the user changes it.
   */
  goal?: string;
  /**
   * Optional PHASE role for fleet routing. When set AND `requestedModel` is `auto`, the run resolves a
   * role-appropriate model from the live fleet (planner/reviewer → strongest reasoner, executor → best coder)
   * instead of the generic best pick. Used by subagent children (scout→planner, oracle→reviewer,
   * builder→executor); an explicit `--model`/preset model always wins (this is ignored unless model is auto).
   */
  routedRole?: RoutedRole;
}

/** What a hook asked for. Every field is optional; an empty outcome means "carry on". */
export interface HookOutcome {
  /** Stop this action (the tool call, the prompt, finishing the run) — the reason is shown to the model. */
  block?: string;
  /** Stop the whole run now (`"continue": false`) — the reason is shown to the user. */
  halt?: string;
  /** Skip the approval prompt for this tool call. Never overrides a denial. */
  allow?: boolean;
  /** Ask before this tool call even where it would otherwise run without asking. */
  ask?: boolean;
  /** Replacement arguments for the tool call (validated like the model's own). */
  updatedInput?: Record<string, unknown>;
  /** Extra context for the model. */
  context?: string;
}

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "Notification";

export interface HooksPort {
  run(
    event: HookEventName,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HookOutcome>;
}
