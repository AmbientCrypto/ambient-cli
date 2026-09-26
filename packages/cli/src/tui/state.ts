import type { Lane, Mode, NewEvent } from "@amb/protocol";
import { AUTO_MODEL } from "@amb/reliability";
import { EFFORT_SETTINGS, type EffortSetting, type ReasoningLevel } from "@amb/runtime";
import { type PlanTask, parsePlanTasks } from "@amb/sessions";

/**
 * Two ORTHOGONAL axes (user design), not one ladder:
 *  - `agentMode` — what it's doing: PLAN (read-only; explore + build a task list) vs BUILD (execute).  Tab toggles.
 *  - `permission` — how much it asks when building: ask / accept-edits / bypass.  Shift+Tab cycles.
 * So "plan with bypass on" is expressible: the permission persists across the plan↔build toggle.
 */
export type AgentMode = "plan" | "build";
export type Permission = "ask" | "accept-edits" | "bypass";

/**
 * Reasoning-effort choice, surfaced next to the model. `auto` is the intelligent default — the agent picks
 * none / high / max per turn from the task and the run's progress, and sends nothing to models that don't
 * advertise `reasoning`. `off` disables it; high/max pin a level. Same union as the runtime's EffortSetting.
 */
export type Effort = EffortSetting;
/** All effort choices, in the order the /effort picker presents them (auto first — the recommended default). */
export const EFFORTS: readonly Effort[] = EFFORT_SETTINGS;

/** The single runtime Mode the permission engine understands, derived from the two axes. */
export function toRuntimeMode(agentMode: AgentMode, permission: Permission): Mode {
  return agentMode === "plan" ? "plan" : permission;
}
/** Shift+Tab cycles the permission: ask → accept-edits → bypass → ask. */
export function nextPermission(p: Permission): Permission {
  const order: Permission[] = ["ask", "accept-edits", "bypass"];
  return order[(order.indexOf(p) + 1) % order.length] ?? "ask";
}
/** Tab toggles plan ↔ build. */
export function toggleAgentMode(m: AgentMode): AgentMode {
  return m === "plan" ? "build" : "plan";
}

/**
 * TUI view-state — a pure reduction of the runtime's event stream (state.ts holds NO React). The App
 * dispatches every emitted NewEvent through `reduce`; components render the result. Immutable updates
 * only (new objects, never mutation) so React re-renders correctly and history stays trustworthy.
 *
 * `reduce` is genuinely pure: item ids come from an immutable `seq` carried in the state (never a
 * module-global), so replay/tests/React-dev double-invocation are deterministic.
 */

export type TranscriptItem =
  // `optimistic`: echoed the instant the user submits (before the catalog fetch → turn.started), so their
  // message + a "Thinking" line appear with ZERO perceived lag; turn.started confirms it in place (no dup).
  | { kind: "user"; id: string; text: string; optimistic?: boolean }
  // `committed`: while STREAMING, completed paragraphs of this answer have already been flushed to <Static> as
  // separate settled assistant items and only the in-progress paragraph remains here (so the live frame stays
  // short and the layout never jumps on settle). It tells `assistant.final` NOT to re-apply the whole finalText
  // over the suffix (that would duplicate the committed prefix).
  | {
      kind: "assistant";
      id: string;
      text: string;
      streaming: boolean;
      spin: number;
      committed?: boolean;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      preview: string;
      diff?: string;
      /** A bounded preview of the tool's OUTPUT (read contents / grep hits / bash stdout) — the single
       *  biggest clarity gap vs Claude Code was showing only "✓ 34ms" with no result. */
      resultPreview?: string;
      exitCode?: number;
      status: "running" | "ok" | "fail";
      durationMs?: number;
      error?: string;
    }
  | { kind: "handoff"; id: string; from: string; to: string; role: string; reason?: string }
  // How long the model reasoned before it answered or acted — kept in scrollback after the live tail clears.
  | { kind: "thought"; id: string; seconds: number; effort?: ReasoningLevel }
  | { kind: "receipt"; id: string; text: string }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; text: string }
  // The DURABLE scrollback record of a subagent wave — one settled line per finished child (+ a closing line),
  // pushed append-only as scouts finish so it commits to <Static> and you scroll up to read what each did (like
  // Claude's Task output). The LIVE, animated wave is NOT a transcript item — it's `ViewState.wave` (a bounded
  // panel), so a running wave can never be a tall re-rendering item that strobes the frame.
  | {
      kind: "subagent-line";
      id: string;
      variant: "child" | "done";
      roleWord: string; // "scouts" | "oracles" | "agents"
      // variant "child" — one finished child:
      label?: string;
      // "partial" = the child returned a useful summary but stopped at its turn limit (or looping) rather than
      // completing — its findings ARE handed to the parent, so it must not read as an outright failure.
      childStatus?: "ok" | "partial" | "fail";
      turns?: number;
      durationMs?: number;
      summary?: string;
      // variant "done" — the wave's closing line:
      count?: number;
      okCount?: number;
      partialCount?: number;
      failCount?: number;
    };

/**
 * A transcript item is SETTLED once it can never change again — safe to commit ONCE to terminal scrollback
 * via Ink's <Static>. The in-flight kinds (a streaming assistant, a running tool/subagent, an unconfirmed
 * optimistic echo) stay LIVE (re-rendered) until they finalize, then flush to the static log.
 */
export function isSettled(item: TranscriptItem): boolean {
  switch (item.kind) {
    case "assistant":
      return !item.streaming;
    case "tool":
      return item.status !== "running";
    // A `user` item is ALWAYS settled — even an optimistic echo. Its text is the user's own input and never
    // changes (turn.started later just drops the `optimistic` flag with identical text). Treating it as live
    // would be unsafe: if the run aborts/errors BEFORE turn.started fires (e.g. Esc during the catalog fetch),
    // the flag is never cleared, so a "live" optimistic item would freeze the settled/live split forever and
    // silently kill scrollback for the rest of the session.
    default:
      return true; // user, handoff, receipt, notice — never mutate meaningfully after they are pushed
  }
}

/** The LIVE state of a running subagent wave — a small, bounded panel (NOT a transcript item), so it can never
 *  become a tall re-rendering frame. Holds no spin/liveText/timestamp (the globe animates off the steady view
 *  tick; elapsed is computed in the view; both keep `reduce` pure). */
export interface WaveState {
  /** id === the parent `subagent` tool-call id. */
  id: string;
  roleWord: string; // "scouts" | "oracles" | "agents"
  total: number; // children in the wave (exact from `subagent.wave`, else counted up from `subagent.started`)
  done: number; // children finished so far
  /** Each running child's current action, bounded — the expanded-panel lines. */
  actions: WaveAction[];
  /** True when `total` came from a `subagent.wave` event (authoritative) — so `subagent.started` doesn't
   *  double-count. Absent/false ⇒ a defensive path counts children up from `subagent.started` instead. */
  exactTotal?: boolean;
  /** childSessionId → label, from `subagent.started` — the later tool/finished events carry only the id. */
  labels: Record<string, string>;
  /** Running tally of children that finished ok (for THIS wave's closing line). */
  okCount: number;
  /** Running tally of children that returned findings but stopped at their turn limit (or looping) — "partial",
   *  not failed. */
  partialCount: number;
}
export interface WaveAction {
  childSessionId: string;
  label: string;
  text: string; // e.g. "Reading src/App.tsx" or "working"
}
/** Cap on the live action lines — ≥ the default subagent concurrency (4), so it can never exceed what runs. */
const MAX_WAVE_ACTIONS = 4;

/** Pluralize a child role for the wave header/record ("scout" → "scouts"; mixed/unknown → "agents"). */
function pluralizeRole(role: string | undefined): string {
  return role ? `${role}s` : "agents";
}

/**
 * The FLIGHTLINE's state — deliberately minimal: what model is running, how hard it reasons, how much
 * context remains, and the session's token total. Only fields the StatusLine actually renders live here;
 * the durable event log (not this view-state) is the source of truth for everything else.
 */
/** What the agent is doing RIGHT NOW — surfaced as the single live activity line while a run is active. */
export interface Activity {
  verb: string;
  detail?: string;
}

export interface Status {
  agentMode: AgentMode;
  permission: Permission;
  /** Reasoning effort shown next to the model; `auto` scales with mode + gates on model capability. */
  effort: Effort;
  requestedModel: string;
  targetModel?: string;
  reportedModel?: string;
  lane?: Lane;
  contextWindow?: number;
  promptEstimate?: number;
  running: boolean;
  stopReason?: string;
  /** The current action (Thinking / Reading / Editing / Running …) for the live activity line. */
  activity?: Activity;
  /** Reasoning effort the runtime ACTUALLY sent for the latest model call (resolves an `auto` setting to a
   *  concrete level) — shown next to "Thinking" so the user sees how hard it's reasoning right now. */
  resolvedEffort?: ReasoningLevel;
  /** Cumulative tokens this session (prompt + completion) — a live, honest cost readout. */
  tokensUsed?: number;
  /** The model call in flight: characters streamed so far (answer + reasoning), when it started, and the
   *  exact completion tokens once the response reports them. Drives the live "↓ 1.2k tok · 40 tok/s". */
  /** `hidden`: tokens the server holds back until complete (a tool call being written). */
  stream?: { chars: number; since?: number; tokens?: number; hidden?: number };
  /** Token counts for this session (never money): requests, prompt/completion totals, and how much of the
   *  prompt came from the provider's cache — plus the latest request's prompt, for /context. */
  usage?: SessionUsage;
}

export interface SessionUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  lastPromptTokens?: number;
  lastCachedTokens?: number;
}

/** One step in the agent's visible task list (maintained via the `plan` tool). */
export type { PlanTask }; // the shared type lives in @amb/sessions (one parser for live + resumed plans)

export interface ViewState {
  transcript: TranscriptItem[];
  status: Status;
  /** The agent's task list (from the `plan` tool) — empty until/unless the model uses it. */
  plan: PlanTask[];
  /** The user's session-long north-star objective (set via `/goal`) — pinned above the transcript. Persists
   *  across turns (NOT reset per run, unlike the plan). Empty/undefined until the user sets one. */
  goal?: string;
  /** Proposed tools awaiting their `tool.started` (keyed by toolCallId) — so the activity line reflects
   *  what's EXECUTING, not the last tool merely PROPOSED (all proposals for a turn are emitted up front). */
  pending: Record<string, Activity>;
  /** Tools that have STARTED but not yet resulted — so a finished tool doesn't reset the line to "Thinking"
   *  while a parallel sibling is still running (the line follows a still-active call instead). */
  active: Record<string, Activity>;
  /** Live model reasoning for the CURRENT step (rolling, bounded, transient — never persisted). Cleared when
   *  the model stops thinking and starts acting (a tool call) or answers. Rendered only when `showThinking`. */
  thinking: string;
  /** Whether the live reasoning block is shown (toggle: `/thinking` or Ctrl+T). */
  showThinking: boolean;
  /** When the model started reasoning in the current step (wall clock ms), until it answers or acts. */
  thinkingSince?: number;
  /** The highest context-fill warning already shown (70/85/95%), so each is said once until compaction. */
  contextWarned?: number;
  /** Immutable monotonic counter for reducer-created item ids (keeps `reduce` pure). */
  seq: number;
  /** The LIVE subagent wave, if one is running — a small bounded panel (NOT a transcript item), so a wave can
   *  never be a tall re-rendering frame. Undefined when no wave is in flight; its durable record is the
   *  `subagent-line` items in the transcript. */
  wave?: WaveState;
}

/** Cap on the retained reasoning buffer — a rolling tail, so a verbose model can't grow the view unbounded. */
export const THINKING_BUFFER_CHARS = 4000;

export function initialState(opts: {
  agentMode: AgentMode;
  permission: Permission;
  effort: Effort;
  requestedModel: string;
  goal?: string;
}): ViewState {
  return {
    transcript: [],
    plan: [],
    ...(opts.goal ? { goal: opts.goal } : {}),
    pending: {},
    active: {},
    thinking: "",
    showThinking: true, // the user wants to SEE the model think by default; toggle with /thinking or Ctrl+T
    seq: 0,
    status: {
      agentMode: opts.agentMode,
      permission: opts.permission,
      effort: opts.effort,
      requestedModel: opts.requestedModel,
      running: false,
    },
  };
}

/** The distinct file paths an apply_patch call edits. */
function patchFiles(a: Record<string, unknown>): string[] {
  if (!Array.isArray(a.edits)) return [];
  const paths = a.edits
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).path : undefined))
    .filter((p): p is string => typeof p === "string");
  return [...new Set(paths)];
}

/** The activity while the model writes a tool call the server only sends once it's complete. */
export const PREPARING_TOOL = "Preparing a tool call";

/** Map a running tool to a human activity verb + a short detail (for the live activity line). */
function toolActivity(toolName: string, args: unknown): Activity {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : undefined;
  const pattern = typeof a.pattern === "string" ? a.pattern : undefined;
  const command = typeof a.command === "string" ? a.command : undefined;
  switch (toolName) {
    case "read":
      return { verb: "Reading", detail: path };
    case "list":
      return { verb: "Listing", detail: path };
    case "glob":
      return { verb: "Finding files", detail: pattern };
    case "grep":
      return { verb: "Searching", detail: pattern };
    case "write":
      return { verb: "Writing", detail: path };
    case "edit":
      return { verb: "Editing", detail: path };
    case "apply_patch": {
      const files = patchFiles(a);
      return {
        verb: "Editing",
        detail:
          files.length === 1 ? files[0] : files.length > 1 ? `${files.length} files` : undefined,
      };
    }
    case "read_artifact":
      return { verb: "Reading saved output" };
    case "ask_vision":
      return {
        verb: "Asking about an image",
        detail: typeof a.question === "string" ? a.question : undefined,
      };
    case "bash":
      return { verb: "Running", detail: command ? command.slice(0, 60) : undefined };
    case "plan":
      return { verb: "Planning" };
    case "search_skills":
      return { verb: "Finding skills", detail: typeof a.query === "string" ? a.query : undefined };
    case "skill":
      return { verb: "Using skill", detail: typeof a.name === "string" ? a.name : undefined };
    case "web_fetch":
      return { verb: "Fetching", detail: typeof a.url === "string" ? a.url : undefined };
    case "web_search":
      return { verb: "Searching web", detail: typeof a.query === "string" ? a.query : undefined };
    case "remember":
      return { verb: "Saving to memory" };
    case "ask_user":
      return { verb: "Waiting for you" };
    default:
      return { verb: `Running ${toolName}`, detail: path };
  }
}

/** Preview the salient arg of a tool call (skill / query / path / command / pattern), for the one-liner. */
function previewArgs(toolName: string, args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    // Skills get their identifying arg surfaced so the friendly "using skill: X" row reads clearly.
    if (toolName === "skill" && typeof a.name === "string") return a.name;
    if (toolName === "search_skills" && typeof a.query === "string") return `"${a.query}"`;
    if (typeof a.path === "string") return a.path;
    if (typeof a.command === "string") return `$ ${(a.command as string).slice(0, 72)}`;
    if (typeof a.pattern === "string") return `/${a.pattern}/`;
  }
  return "";
}

/** Short model name — drop the vendor prefix (defensive against a non-string from a malformed event). */
export function shortName(id: string): string {
  const s = typeof id === "string" ? id : String(id ?? "");
  const i = s.lastIndexOf("/");
  const name = i >= 0 ? s.slice(i + 1) : s;
  // A bare word with no version ("large") says nothing on its own — keep the vendor prefix for those.
  return /\d/.test(name) ? name : s;
}

/** Append a tool item (id comes from the runtime's globally-unique tool-call id). */
function push(s: ViewState, item: TranscriptItem): ViewState {
  return { ...s, transcript: [...s.transcript, item] };
}

/**
 * Append a reducer-created item with a deterministic id derived from the immutable `seq`. Pure: the id
 * is a function of state, so the same (state, event) always yields the same result.
 */
function pushItem(s: ViewState, make: (id: string) => TranscriptItem): ViewState {
  const seq = s.seq + 1;
  return { ...s, seq, transcript: [...s.transcript, make(`i-${seq}`)] };
}

/** Count ``` code-fence toggles in a string (to know whether an offset sits inside an open fence). */
function fenceToggles(s: string): number {
  const m = s.match(/```/g);
  return m ? m.length : 0;
}

/**
 * Split a STREAMING answer into a committable prefix (completed paragraphs, safe to flush ONCE to <Static>) and
 * a live remainder (the in-progress paragraph, kept re-rendering). This is what keeps the live frame short so
 * the layout never jumps on settle: finished paragraphs flow top-down into scrollback as they complete.
 *
 * Rules that make it safe against <Static>'s unrevertable, append-only contract:
 *  - commit only at a blank-line paragraph break (`\n\n`);
 *  - NEVER commit at a break that sits inside an open ``` code fence (a code block's whitespace is load-bearing
 *    and `assistant.final` may retro-correct it — Static can't be rewritten);
 *  - NEVER commit the final paragraph (there must be real content after the break — it stays live until final).
 * Returns null when nothing can be committed yet. Pure + unit-tested.
 */
export function splitCommittable(text: string): { commit: string; live: string } | null {
  let best = -1;
  for (let p = text.indexOf("\n\n"); p >= 0; p = text.indexOf("\n\n", p + 1)) {
    const after = text.slice(p + 2);
    if (after.trim().length === 0) break; // no real remainder past here (and none further) → keep it all live
    if (fenceToggles(text.slice(0, p)) % 2 === 0) best = p; // fence-balanced boundary → committable
  }
  if (best < 0) return null;
  const commit = text.slice(0, best); // completed paragraphs, no trailing newline (best is at the break)
  const live = text.slice(best + 2).replace(/^\n+/, ""); // drop any extra separator newlines from the live head
  if (commit.length === 0 || live.length === 0) return null;
  return { commit, live };
}

function replaceAt(items: TranscriptItem[], idx: number, item: TranscriptItem): TranscriptItem[] {
  return [...items.slice(0, idx), item, ...items.slice(idx + 1)];
}

/** Turn a settled run's in-flight items terminal: streaming assistants stop; running tools become failed. */
function terminalizeInFlight(items: TranscriptItem[], cancelled: boolean): TranscriptItem[] {
  let changed = false;
  const next = items.map((it) => {
    if (it.kind === "assistant" && it.streaming) {
      changed = true;
      return { ...it, streaming: false };
    }
    if (it.kind === "tool" && it.status === "running") {
      changed = true;
      return {
        ...it,
        status: "fail" as const,
        error: it.error ?? (cancelled ? "cancelled" : "interrupted"),
      };
    }
    // A running subagent wave is not a transcript item — it lives in `ViewState.wave` and is cleared by
    // `withStop` on cancel/interrupt, so nothing here needs to terminalize it.
    return it;
  });
  return changed ? next : items;
}

/** The fields that describe ONE run — reset per session so a second task never shows a stale model/gauge. */
function resetRunScoped(status: Status): Status {
  return {
    ...status,
    stopReason: undefined,
    targetModel: undefined,
    reportedModel: undefined,
    lane: undefined,
    contextWindow: undefined,
    promptEstimate: undefined,
    activity: undefined,
    stream: undefined,
  };
}

/**
 * Fold one event into the view state. Kept exhaustive-ish; unknown kinds pass through untouched so the
 * TUI never crashes on a new event type.
 */
/**
 * The model stopped reasoning (it answered, acted, or the call ended): record how long it thought as a
 * settled row. `now` is 0 when the caller has no clock (replay) — then nothing is recorded.
 */
function settleThought(state: ViewState, now: number): ViewState {
  if (state.thinkingSince === undefined) return state;
  const since = state.thinkingSince;
  const cleared: ViewState = { ...state, thinkingSince: undefined };
  if (now <= 0) return cleared;
  const effort = state.status.resolvedEffort;
  return pushItem(cleared, (id) => ({
    kind: "thought",
    id,
    seconds: Math.max(0, (now - since) / 1000),
    ...(effort ? { effort } : {}),
  }));
}

/** Context-fill levels that earn a one-time heads-up. */
export const CONTEXT_WARN_LEVELS = [70, 85, 95] as const;

/** Say once when the conversation crosses 70 / 85 / 95% of the model's window. */
function contextWarning(state: ViewState, used: number, window: number): ViewState {
  if (!(window > 0)) return state;
  const pct = (used / window) * 100;
  const level = [...CONTEXT_WARN_LEVELS].reverse().find((l) => pct >= l);
  if (level === undefined || level <= (state.contextWarned ?? 0)) return state;
  const text = `context ${Math.round(pct)}% full — it compacts automatically when needed · /compact [focus] to choose what's kept`;
  return pushItem({ ...state, contextWarned: level }, (id) => ({
    kind: "notice",
    id,
    level: level >= 85 ? "warn" : "info",
    text,
  }));
}

/** Fold one response's token counts into the session totals. */
function addUsage(
  usage: SessionUsage | undefined,
  ev: { promptTokens?: number; completionTokens?: number; cachedTokens?: number },
): SessionUsage {
  const u = usage ?? { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  return {
    requests: u.requests + 1,
    promptTokens: u.promptTokens + (ev.promptTokens ?? 0),
    completionTokens: u.completionTokens + (ev.completionTokens ?? 0),
    cachedTokens: u.cachedTokens + (ev.cachedTokens ?? 0),
    // The latest request's own figures (a response without cache info had nothing from cache).
    ...(ev.promptTokens !== undefined
      ? { lastPromptTokens: ev.promptTokens, lastCachedTokens: ev.cachedTokens ?? 0 }
      : {}),
  };
}

/** Count streamed characters toward the in-flight call's live token readout. */
function addStreamed(status: Status, text: string, now: number): Status {
  const stream = status.stream ?? { chars: 0 };
  // The rate is measured from the first token, so the time the model spends reading the prompt doesn't
  // drag it down.
  const since = stream.since ?? (now > 0 && text.length > 0 ? now : undefined);
  return {
    ...status,
    stream: {
      ...stream,
      chars: stream.chars + text.length,
      ...(since !== undefined ? { since } : {}),
    },
  };
}

/** True while an answer is already streaming — reasoning that arrives now is part of the same reply. */
const answerStreaming = (state: ViewState) => {
  const last = state.transcript[state.transcript.length - 1];
  return last?.kind === "assistant" && last.streaming;
};

/** `now` (wall clock ms) lets the view time reasoning; omitted in replay and most tests. */
export function reduce(state: ViewState, ev: NewEvent, now = 0): ViewState {
  switch (ev.kind) {
    case "session.started":
      // A run just started: reset run-scoped counters + the plan (a new session === a new run) so a
      // repeated task never carries the previous one's plan/turn/model. The transcript is preserved.
      // Activity stays "Thinking" (not cleared) so the indicator the optimistic echo already showed doesn't
      // flicker off during the catalog fetch (session.started → [fetch] → turn.started).
      return {
        ...state,
        // An unfinished plan carries into the next run (the App seeds it into the agent too), so the panel
        // keeps showing what the agent is executing; a fully finished plan is retired.
        plan: state.plan.some((t) => t.status !== "done") ? state.plan : [],
        pending: {},
        active: {},
        thinking: "",
        thinkingSince: undefined,
        status: { ...resetRunScoped(state.status), running: true, activity: { verb: "Thinking" } },
      };

    case "goal.set":
      // A durable goal change (from the `propose_goal_update` tool the user approved) — reflect it in the
      // pinned goal line immediately. The `/goal` command drives the same state via setGoal directly.
      return setGoal(state, ev.text);

    case "turn.started": {
      // If the App already echoed this message optimistically (the common TUI path), CONFIRM that item in
      // place — drop the `optimistic` flag + reconcile the text — instead of pushing a duplicate. Otherwise
      // (replay / non-TUI) push it fresh, exactly as before.
      const base = {
        ...state,
        thinking: "",
        status: { ...state.status, running: true, activity: { verb: "Thinking" as const } },
      };
      const lastIdx = state.transcript.length - 1;
      const last = state.transcript[lastIdx];
      if (last?.kind === "user" && last.optimistic) {
        return {
          ...base,
          transcript: replaceAt(state.transcript, lastIdx, {
            kind: "user",
            id: last.id,
            text: ev.input,
          }),
        };
      }
      return pushItem(base, (id) => ({ kind: "user", id, text: ev.input }));
    }

    case "model.resolved": {
      const status = {
        ...state.status,
        targetModel: ev.targetModel,
        lane: ev.lane,
        requestedModel: ev.requestedModel,
      };
      // An `auto` pick is the DEFAULT, not a substitution — the flightline already shows "←auto", so a
      // receipt reading "you asked for auto (no model requested)" is confusing noise. Only surface a receipt
      // for a REAL substitution: an explicit model the user named was swapped (cold or unknown).
      if (ev.targetModel !== ev.requestedModel && ev.requestedModel !== AUTO_MODEL) {
        const served = shortName(ev.targetModel);
        const asked = shortName(ev.requestedModel);
        return pushItem({ ...state, status }, (id) => ({
          kind: "receipt",
          id,
          text: `served by ${served} · you asked for ${asked} (${ev.reason ?? "warm substitute"})`,
        }));
      }
      return { ...state, status };
    }

    case "context.preflight": {
      const next: ViewState = {
        ...state,
        status: {
          ...state.status,
          contextWindow: ev.contextWindow,
          promptEstimate: ev.promptEstimate,
        },
      };
      return ev.promptEstimate !== undefined && ev.contextWindow !== undefined
        ? contextWarning(next, ev.promptEstimate, ev.contextWindow)
        : next;
    }

    case "inference.request":
      // A new model call: its live token count starts from zero, and the effort it was sent with is known
      // now (so "Thinking · max" describes THIS call, not the previous one).
      return {
        ...state,
        status: {
          ...state.status,
          stream: { chars: 0 },
          // A model that doesn't reason is sent no effort — don't keep showing the previous model's level.
          resolvedEffort: ev.effort ? toReasoningLevel(ev.effort) : undefined,
        },
      };

    case "inference.response": {
      // Fold: who ACTUALLY served (post-substitution), the reasoning effort really sent (resolves `auto`),
      // and cumulative session token usage (a live, honest cost readout).
      const addTokens = (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0);
      const settled = settleThought(state, now);
      return {
        ...settled,
        status: {
          ...settled.status,
          ...(ev.reportedModel ? { reportedModel: ev.reportedModel } : {}),
          ...(ev.effort ? { resolvedEffort: toReasoningLevel(ev.effort) } : {}),
          ...(addTokens > 0 ? { tokensUsed: (settled.status.tokensUsed ?? 0) + addTokens } : {}),
          ...(settled.status.stream && ev.completionTokens !== undefined
            ? { stream: { ...settled.status.stream, tokens: ev.completionTokens } }
            : {}),
          usage: addUsage(settled.status.usage, ev),
        },
      };
    }

    case "steer":
      // A mid-run steer the user injected into the running conversation — show it inline as a user turn
      // (settled, so it commits to scrollback like any message).
      return pushItem(state, (id) => ({
        kind: "user",
        id,
        text: typeof ev.text === "string" ? ev.text : "",
      }));

    case "reasoning.delta": {
      // Live model thinking for the CURRENT step — a rolling, bounded, transient tail (never persisted).
      const text = typeof ev.text === "string" ? ev.text : "";
      if (text.length === 0) return state;
      const buf = (state.thinking + text).slice(-THINKING_BUFFER_CHARS);
      // Reasoning that arrives once the answer is already streaming (or is only whitespace) doesn't start a
      // new "thought" — that would split the answer around a thought row.
      const startsThought =
        state.thinkingSince === undefined && text.trim().length > 0 && !answerStreaming(state);
      return {
        ...state,
        thinking: buf,
        thinkingSince: startsThought && now > 0 ? now : state.thinkingSince,
        status: {
          ...addStreamed(state.status, text, now),
          ...(answerStreaming(state) ? {} : { activity: { verb: "Thinking" } }),
        },
      };
    }

    case "assistant.delta": {
      const text = typeof ev.text === "string" ? ev.text : ""; // guard a malformed event
      // The model moved from thinking to answering → clear the live reasoning tail, keep how long it thought,
      // and say it's answering (unless tools are still running alongside).
      const answering = text.trim().length > 0;
      const thought = answering && !answerStreaming(state) ? settleThought(state, now) : state;
      const counted: ViewState = {
        ...thought,
        status: {
          ...addStreamed(thought.status, text, now),
          ...(answering && Object.keys(thought.active).length === 0
            ? { activity: { verb: "Answering" } }
            : {}),
        },
      };
      const base = counted.thinking ? { ...counted, thinking: "" } : counted;
      const last = base.transcript[base.transcript.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        const full = last.text + text;
        // Flush completed paragraphs to <Static> as their own settled items; keep only the in-progress
        // paragraph live. Each committed item + the live suffix render with the same marginTop, so the
        // paragraph spacing is identical to an unsplit answer — but the live frame never grows tall.
        const split = splitCommittable(full);
        if (split) {
          const seq = base.seq + 1;
          const committed: TranscriptItem = {
            kind: "assistant",
            id: `i-${seq}`,
            text: split.commit,
            streaming: false,
            spin: 0,
          };
          // `spin` advances one frame per streamed chunk — the globe turns at the model's real token rate.
          const streaming: TranscriptItem = {
            ...last,
            text: split.live,
            spin: last.spin + 1,
            committed: true,
          };
          return {
            ...base,
            seq,
            transcript: [...base.transcript.slice(0, -1), committed, streaming],
          };
        }
        const updated: TranscriptItem = { ...last, text: full, spin: last.spin + 1 };
        return { ...base, transcript: [...base.transcript.slice(0, -1), updated] };
      }
      // Don't OPEN a streaming item on whitespace-only content — a model that streams a blank preamble
      // then emits tool calls (no assistant.final) would otherwise leave a blank, forever-spinning line.
      if (text.trim().length === 0) return base;
      return pushItem(base, (id) => ({
        kind: "assistant",
        id,
        text,
        streaming: true,
        spin: 0,
      }));
    }

    case "assistant.final": {
      const finalText = typeof ev.text === "string" ? ev.text : "";
      // Finalize the LATEST streaming assistant (not just the last item — a tool call may sit after it).
      const idx = state.transcript.findLastIndex((t) => t.kind === "assistant" && t.streaming);
      if (idx >= 0) {
        const item = state.transcript[idx] as Extract<TranscriptItem, { kind: "assistant" }>;
        // The final IS the canonical complete text — prefer it when present (the streamed accumulation may
        // be missing a dropped leading-whitespace delta, e.g. an indented code block's indentation). BUT once
        // paragraphs of this answer were incrementally committed to <Static>, `item.text` is only the live
        // SUFFIX — re-applying the whole finalText here would duplicate the committed prefix, so keep the
        // streamed suffix as-is (the committed prose is whitespace-safe; a dropped suffix delta is rare and
        // self-heals to no worse than today).
        const text = item.committed ? item.text : finalText.length > 0 ? finalText : item.text;
        return {
          ...state,
          transcript: replaceAt(state.transcript, idx, {
            ...item,
            text,
            streaming: false,
          }),
        };
      }
      if (finalText.length === 0) return state;
      return pushItem(state, (id) => ({
        kind: "assistant",
        id,
        text: finalText,
        streaming: false,
        spin: 0,
      }));
    }

    case "tool.drafting": {
      // A tool call is still streaming in: say what the agent is about to do ("Writing src/app.ts") instead
      // of a bare "Thinking" while a long file's arguments arrive. Running tools keep the line.
      if (Object.keys(state.active).length > 0) return state;
      const acted = settleThought(state, now);
      const activity = ev.toolName
        ? toolActivity(ev.toolName, ev.path ? { path: ev.path } : {})
        : { verb: PREPARING_TOOL };
      const stream = acted.status.stream ?? { chars: 0 };
      return {
        ...acted,
        status: {
          ...acted.status,
          activity,
          // Tokens the server is holding back still count toward what's been produced.
          ...(ev.tokens !== undefined
            ? {
                stream: {
                  ...stream,
                  hidden: ev.tokens,
                  ...(stream.since === undefined && now > 0 ? { since: now } : {}),
                },
              }
            : {}),
        },
      };
    }

    case "tool.proposed": {
      // Record what THIS call will do, keyed by id — the activity line reads it on `tool.started` (all
      // proposals for a turn are emitted up front, so proposal order is NOT execution order).
      // The model stopped reasoning and started acting.
      const acted = settleThought(state, now);
      const pending = { ...acted.pending, [ev.toolCallId]: toolActivity(ev.toolName, ev.args) };
      // The `plan` tool updates the pinned task list, not the transcript — fold it and don't show a row.
      if (ev.toolName === "plan") {
        const plan = parsePlanTasks(ev.args);
        const next = { ...acted, pending };
        return plan ? { ...next, plan } : next;
      }
      // The `subagent` tool renders its OWN richer transcript item on `subagent.started` — DON'T also push a
      // generic tool row here, or the two collide on the same toolCallId (duplicate React key + a stray "◐
      // subagent" line above the real tree). Keep the pending entry so the activity line still reflects it.
      if (ev.toolName === "subagent") return { ...acted, pending };
      // The diff isn't known at proposal time — it's produced by the tool's OUTPUT and arrives on tool.result.
      return push(
        { ...acted, pending },
        {
          kind: "tool",
          id: ev.toolCallId,
          name: ev.toolName,
          preview: previewArgs(ev.toolName, ev.args),
          status: "running",
        },
      );
    }

    case "tool.started": {
      // The tool is actually EXECUTING now — move it from pending → active and surface its verb/detail.
      // The model has stopped thinking and started acting → clear the live reasoning tail.
      const verb = state.pending[ev.toolCallId] ?? { verb: "Thinking" };
      const { [ev.toolCallId]: _p, ...pending } = state.pending;
      return {
        ...state,
        thinking: "",
        pending,
        active: { ...state.active, [ev.toolCallId]: verb },
        status: { ...state.status, activity: verb },
      };
    }

    case "tool.result": {
      // Match the NEWEST tool with this id (ids are globally unique, but the transcript accumulates
      // across tasks — a reverse search is robust and always targets the live call).
      const idx = state.transcript.findLastIndex(
        (t) => t.kind === "tool" && t.id === ev.toolCallId,
      );
      // Drop this call from pending + active. The activity follows a STILL-running sibling (parallel reads)
      // if any; else back to "Thinking". A folded `plan` result (idx<0) takes the same path so "Planning"
      // never sticks.
      const { [ev.toolCallId]: _p, ...pending } = state.pending;
      const { [ev.toolCallId]: _a, ...active } = state.active;
      const rest = Object.values(active);
      // With several tools in flight, name WHAT (the distinct verbs) instead of a bare "N tools" so the line
      // still says what it's doing.
      const verbHint = Array.from(new Set(rest.map((a) => (a as Activity).verb.toLowerCase())))
        .slice(0, 3)
        .join(", ");
      const activity: Activity =
        rest.length === 0
          ? { verb: "Thinking" }
          : rest.length === 1
            ? (rest[0] as Activity)
            : { verb: "Running", detail: `${rest.length} tools · ${verbHint}` };
      if (idx < 0) {
        return { ...state, pending, active, status: { ...state.status, activity } };
      }
      const item = state.transcript[idx] as Extract<TranscriptItem, { kind: "tool" }>;
      // The unified diff (write/edit OUTPUT) rides on tool.result — attach it now so the Diff renderer fires.
      const updated: TranscriptItem = {
        ...item,
        status: ev.ok ? "ok" : "fail",
        durationMs: ev.durationMs,
        error: ev.error,
        ...(ev.diff ? { diff: ev.diff } : {}),
        // Show the OUTPUT for tools without a diff (read/grep/bash/list) — a diff is its own better preview.
        ...(!ev.diff && ev.ok && ev.preview ? { resultPreview: ev.preview } : {}),
        ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
      };
      return {
        ...state,
        pending,
        active,
        transcript: replaceAt(state.transcript, idx, updated),
        status: { ...state.status, activity },
      };
    }

    case "handoff": {
      // A UTILITY handoff (e.g. routing compaction to a cheap model) is a momentary side call, NOT a change to
      // who's flying your task — it must NOT repoint the flightline (it stuck even when the compactor
      // call failed and we fell back). Only a real serving switch (failover/substitution) updates target/lane.
      const utility = ev.role === "compactor";
      const status = utility
        ? state.status
        : {
            ...state.status,
            targetModel: ev.to,
            // Clear the PRIOR model's reportedModel — otherwise StatusLine (which prefers reportedModel) would
            // keep naming the failed model until/unless the substitute's response reports its own name.
            reportedModel: undefined,
            ...(ev.lane ? { lane: ev.lane } : {}),
          };
      return pushItem({ ...state, status }, (id) => ({
        kind: "handoff",
        id,
        from: ev.from,
        to: ev.to,
        role: ev.role,
        reason: ev.reason,
      }));
    }

    case "vision.relay.started":
      // The served model can't see images, so a vision model is looking for it — say exactly that.
      return {
        ...state,
        status: {
          ...state.status,
          activity: {
            verb: `Looking at ${ev.imageCount === 1 ? "your image" : `${ev.imageCount} images`}`,
            detail: `${shortName(ev.visionModel)} for ${shortName(ev.targetModel)}`,
          },
        },
      };

    case "vision.relay": {
      // A calm one-line receipt about how an attached image was handled. NATIVE (the model saw it) needs no
      // line — it just works. The relay/degrade outcomes are surfaced so the user knows what happened.
      if (ev.outcome === "native") return state;
      const text =
        ev.outcome === "described"
          ? ev.visionModel
            ? `${shortName(ev.targetModel)} can't see images — ${shortName(ev.visionModel)} described ${ev.imageCount === 1 ? "it" : `all ${ev.imageCount}`}${ev.descriptionChars ? ` (${ev.descriptionChars.toLocaleString("en-US")} chars)` : ""}`
            : `${shortName(ev.targetModel)} can't see images — reused the description from earlier`
          : ev.outcome === "no-model"
            ? `${shortName(ev.targetModel)} can't see images, and no vision model is live — proceeding from your text`
            : ev.outcome === "cold"
              ? `${shortName(ev.targetModel)} can't see images, and every vision model is cold (tried ${(ev.tried ?? []).map(shortName).join(", ") || "none"}) — proceeding from your text`
              : `couldn't read the attached image${ev.tried?.length ? ` (tried ${ev.tried.map(shortName).join(", ")})` : ""} — proceeding from your text`;
      return pushItem(state, (id) => ({ kind: "receipt", id, text }));
    }

    case "error": {
      // rate_limit / cold are AUTOMATICALLY retried + failed-over by the runtime — they're transient, not
      // failures. Show them as ONE calm dim line (deduped), never a wall of red that reads as "broken". But a
      // TERMINAL error (retryable:false, e.g. empty fleet) must NOT claim "retrying / failing over…" even if
      // its kind is transport — honor the explicit signal over the kind.
      const transient =
        ev.retryable !== false &&
        (ev.errorKind === "rate_limit" || ev.errorKind === "cold" || ev.errorKind === "transport");
      const who = ev.model ? shortName(ev.model) : "the model";
      const state_word =
        ev.errorKind === "cold"
          ? "warming up"
          : ev.errorKind === "transport"
            ? "unreachable"
            : "busy";
      const text = transient
        ? `${who} is ${state_word} — retrying / failing over…`
        : ev.errorKind === "auth"
          ? "Ambient rejected your API key — it may have been revoked or mistyped."
          : `${ev.errorKind}: ${ev.message}`;
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === "notice" && last.text === text) return state; // collapse the burst
      return pushItem(state, (id) => ({
        kind: "notice",
        id,
        level: transient ? "info" : "error",
        text,
      }));
    }

    case "notice":
      return pushItem(state, (id) => ({ kind: "notice", id, level: ev.level, text: ev.text }));

    case "context.overflow":
      return pushItem(state, (id) => ({
        kind: "notice",
        id,
        level: "warn",
        text: `context overflow on ${ev.model} — could not fit even after compaction`,
      }));

    case "context.compacted":
      return pushItem(
        {
          ...state,
          contextWarned: undefined, // room again — warn afresh if it fills back up
          status: { ...state.status, activity: { verb: "Compacting context" } },
        },
        (id) => ({
          kind: "notice",
          id,
          level: "info",
          text: `compacted context (${ev.summarizedPhases} messages summarized)`,
        }),
      );

    case "verify.gate":
      return pushItem(
        {
          ...state,
          status: {
            ...state.status,
            activity: ev.ok ? undefined : { verb: "Fixing failed verification" },
          },
        },
        (id) => ({
          kind: "notice",
          id,
          level: ev.ok ? "info" : "warn",
          text: ev.ok
            ? "verification passed"
            : `verification failed — re-asking the model to fix it${ev.summary ? `\n${ev.summary.split("\n").slice(0, 6).join("\n")}` : ""}`,
        }),
      );

    case "subagent.wave": {
      // One-shot, up front: initialize the LIVE wave panel with the EXACT child count, so the header reads
      // right from frame one and the closing line fires exactly once even for waves larger than concurrency.
      return {
        ...state,
        wave: {
          id: ev.toolCallId,
          roleWord: pluralizeRole(ev.role),
          total: ev.count,
          done: 0,
          actions: [],
          exactTotal: true,
          labels: {},
          okCount: 0,
          partialCount: 0,
        },
        status: { ...state.status, activity: { verb: "Delegating" } },
      };
    }

    case "subagent.started": {
      const status: Status = {
        ...state.status,
        activity: { verb: "Delegating", detail: ev.label },
      };
      if (state.wave && state.wave.id === ev.toolCallId) {
        // Record the label; grow `total` only when it wasn't already fixed by a `subagent.wave` event.
        return {
          ...state,
          status,
          wave: {
            ...state.wave,
            total: state.wave.exactTotal ? state.wave.total : state.wave.total + 1,
            labels: { ...state.wave.labels, [ev.childSessionId]: ev.label },
          },
        };
      }
      // Defensive: a `subagent.started` with no preceding `subagent.wave` still shows a panel, counting up.
      return {
        ...state,
        status,
        wave: {
          id: ev.toolCallId,
          roleWord: pluralizeRole(ev.role),
          total: 1,
          done: 0,
          actions: [],
          labels: { [ev.childSessionId]: ev.label },
          okCount: 0,
          partialCount: 0,
        },
      };
    }

    case "subagent.delta":
      // The child's streamed prose is no longer surfaced live (it drove the tall re-rendering panel + strobe);
      // its substance lands in the finish summary that commits to scrollback. No-op for the view.
      return state;

    case "subagent.tool": {
      if (!state.wave || state.wave.id !== ev.toolCallId) return state; // unknown parent → no-op
      const label = state.wave.labels[ev.childSessionId] ?? "";
      const verb = toolActivity(ev.toolName, {}).verb;
      // running → the current action ("Reading src/App.tsx"); settled → neutral "working" between tools.
      const text =
        ev.status === "running" ? `${verb}${ev.preview ? ` ${ev.preview}` : ""}` : "working";
      // Upsert this child's action into the bounded ring (most-recent kept, capped so height is stable).
      const others = state.wave.actions.filter((a) => a.childSessionId !== ev.childSessionId);
      const actions = [...others, { childSessionId: ev.childSessionId, label, text }].slice(
        -MAX_WAVE_ACTIONS,
      );
      const detail = ev.status === "running" ? ev.preview : "working";
      return {
        ...state,
        wave: { ...state.wave, actions },
        status: {
          ...state.status,
          activity: label
            ? { verb: `↳ ${label}`, ...(detail ? { detail } : {}) }
            : (state.status.activity ?? { verb: "Delegating" }),
        },
      };
    }

    case "subagent.finished": {
      if (!state.wave || state.wave.id !== ev.toolCallId) return state; // unknown parent → no-op
      const label = state.wave.labels[ev.childSessionId] ?? "";
      const roleWord = state.wave.roleWord;
      // A child that stopped at its turn limit (or the doom-loop guard) still handed its findings summary to
      // the parent — that's "partial", not a failure. Only a genuine error/cancel/block reads as failed.
      const childStatus: "ok" | "partial" | "fail" =
        ev.stopReason === "complete"
          ? "ok"
          : ev.stopReason === "max_turns" || ev.stopReason === "looping"
            ? "partial"
            : "fail";
      // 1) Append the durable per-child scrollback line (settled → commits to <Static> immediately).
      let next = pushItem(state, (id) => ({
        kind: "subagent-line",
        id,
        variant: "child",
        roleWord,
        label,
        childStatus,
        turns: ev.turns,
        durationMs: ev.durationMs,
        ...(ev.summary ? { summary: ev.summary } : {}),
      }));
      const done = state.wave.done + 1;
      const okCount = state.wave.okCount + (childStatus === "ok" ? 1 : 0);
      const partialCount = state.wave.partialCount + (childStatus === "partial" ? 1 : 0);
      const remainingActions = state.wave.actions.filter(
        (a) => a.childSessionId !== ev.childSessionId,
      );
      if (done >= state.wave.total) {
        // 2) Wave complete → append the closing line and drop the live panel (record is now all in scrollback).
        const count = state.wave.total;
        next = pushItem(next, (id) => ({
          kind: "subagent-line",
          id,
          variant: "done",
          roleWord,
          count,
          okCount,
          partialCount,
          failCount: count - okCount - partialCount,
        }));
        return { ...next, wave: undefined };
      }
      return {
        ...next,
        wave: { ...state.wave, done, okCount, partialCount, actions: remainingActions },
      };
    }

    case "run.checkpoint":
      // A turn-budget checkpoint. `auto_continue` → a visible "compacted, continuing" marker so a long
      // auto-continue run never looks frozen; `paused` is surfaced by the end-of-run stop notice instead
      // (the run stops right after emitting it).
      return ev.reason === "auto_continue"
        ? pushItem(state, (id) => ({
            kind: "notice",
            id,
            level: "info",
            text: `◆ Checkpoint ${ev.segment}/${ev.of} — continuing…`,
          }))
        : state;

    case "turn.finished":
      return {
        ...state,
        pending: {},
        active: {},
        thinking: "", // clear the reasoning tail at definitive turn end (incl. a reasoning-only blocked turn)
        status: { ...state.status, running: false, activity: undefined },
      };

    default:
      return state;
  }
}

/**
 * Mark the run finished with a stop reason (called when Agent.run settles). Also terminalizes any
 * in-flight items — a stream cut off by an abort/error must not blink forever.
 */
export function withStop(state: ViewState, stopReason: string): ViewState {
  const stopped: ViewState = {
    ...state,
    transcript: terminalizeInFlight(state.transcript, stopReason === "cancelled"),
    pending: {},
    active: {},
    thinking: "", // a stopped run (incl. reasoning-only blocked/cancelled) must not leave a stale thinking tail
    wave: undefined, // a cancelled/interrupted run must never leave a spinning wave panel
    status: { ...state.status, running: false, stopReason, activity: undefined },
  };
  // A non-`complete` stop leaves the composer idle with no explanation — the "is it frozen?" gap. Append a
  // durable one-line notice saying WHY it stopped and what to do, so the end state is always legible. `complete`
  // (a clean finish) and `cancelled` (the user's own Ctrl-C) speak for themselves; `error` already printed one.
  const notice = stopNotice(stopReason);
  return notice
    ? pushItem(stopped, (id) => ({ kind: "notice", id, level: notice.level, text: notice.text }))
    : stopped;
}

/** The end-of-run explanation for a non-`complete` stop, or undefined when no extra line is warranted. */
function stopNotice(
  stopReason: string,
): { level: "info" | "warn" | "error"; text: string } | undefined {
  switch (stopReason) {
    case "max_turns":
      return {
        level: "warn",
        text: '⚠ Reached the turn limit — the findings and plan above are saved. Type "continue" (or give direction) to keep going.',
      };
    case "looping":
      return {
        level: "warn",
        text: "⚠ Stopped — the model kept repeating itself with no progress. The work so far is above.",
      };
    case "blocked":
      return {
        level: "warn",
        text: "⚠ Stopped — the work didn't fit the model's context window. Try a model with a larger window.",
      };
    case "verify_failed":
      return {
        level: "warn",
        text: "⚠ Stopped — automated verification didn't pass. See the diagnostics above.",
      };
    default:
      return undefined; // complete / cancelled / error → no extra line
  }
}

/**
 * Echo the user's submitted message INSTANTLY (before the run's catalog fetch), with the "Thinking" activity
 * line, so pressing Enter has zero perceived lag. The item is flagged `optimistic`; the run's `turn.started`
 * event later confirms it in place (no duplicate). Purely additive — the non-TUI path never calls this and
 * still gets its user echo from `turn.started`.
 */
export function optimisticEcho(state: ViewState, text: string): ViewState {
  return pushItem(
    {
      ...state,
      thinking: "",
      status: { ...state.status, running: true, activity: { verb: "Thinking" } },
    },
    (id) => ({ kind: "user", id, text, optimistic: true }),
  );
}

/** Push a notice into the transcript (for slash-command feedback like /help, /model, /models). */
export function appendNotice(
  state: ViewState,
  level: "info" | "warn" | "error",
  text: string,
): ViewState {
  return pushItem(state, (id) => ({ kind: "notice", id, level, text }));
}

/** Clear the visible transcript (the /clear slash command). KEEPS the pinned plan + run status (see below). */
export function clearTranscript(state: ViewState): ViewState {
  // Only wipe the visible scrollback — KEEP the pinned plan + the in-flight execution bookkeeping
  // (pending/active) so a mid-run /clear can't lose the plan or strand the activity verb.
  return { ...state, transcript: [] };
}

/** Set the requested model in the status (the /model slash command); takes effect on the next run. */
export function setRequestedModel(state: ViewState, requestedModel: string): ViewState {
  return { ...state, status: { ...state.status, requestedModel } };
}

/** Set the reasoning effort in the status (the /effort slash command); takes effect on the next run. */
export function setEffort(state: ViewState, effort: Effort): ViewState {
  return { ...state, status: { ...state.status, effort } };
}

/** Hard cap on a goal's length — a north-star buys its permanent seat in context by staying tiny (~2
 *  sentences); a long goal both wastes the window every turn and dilutes a weaker model's attention. */
export const MAX_GOAL_CHARS = 280;

/** Set (or clear, with "") the session's north-star goal (the /goal command). Trimmed + length-capped; an
 *  empty string clears it. Takes effect on the next run and shows in the pinned goal line immediately. */
export function setGoal(state: ViewState, goal: string): ViewState {
  const trimmed = goal.trim().slice(0, MAX_GOAL_CHARS);
  return { ...state, ...(trimmed ? { goal: trimmed } : { goal: undefined }) };
}

/** Fold a logged effort (older logs recorded low/medium) onto the three tiers Ambient serves. */
function toReasoningLevel(e: string): ReasoningLevel {
  return e === "none" || e === "max" ? e : "high";
}
