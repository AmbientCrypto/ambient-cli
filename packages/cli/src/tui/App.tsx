import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  type SlashCommand as CustomCommand,
  IMAGE_EDGE_HIGH,
  discoverAgents,
  discoverCommands,
} from "@amb/context";
import { guardUntrustedResult } from "@amb/permissions";
import {
  type AskRequest,
  type AskResponse,
  type Grant,
  type ImageAttachment,
  type NewEvent,
  type ToolDefinition,
  newSessionId,
} from "@amb/protocol";
import { AUTO_MODEL, UNKNOWN_OUTPUT, budgetsFor } from "@amb/reliability";
import {
  Agent,
  type CapabilityPort,
  type ChatClient,
  type Msg,
  type ReasoningLevel,
  type RunOptions,
  newRunState,
  normalizeEffortSetting,
} from "@amb/runtime";
import {
  type SessionWriter,
  parsePlanTasks,
  readObject,
  readSession,
  reconstructTranscript,
  saveObject,
} from "@amb/sessions";
import { createBuiltinRegistry } from "@amb/tools-core";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { expandSlashCommand } from "../agent/command-expand.js";
import { compactNow } from "../agent/compact-now.js";
import { createDurableEventSink } from "../agent/event-sink.js";
import { fireAndForget } from "../agent/hooks.js";
import { makeImageLoader } from "../agent/load-image.js";
import { type McpControl, mcpReport, splitArgs } from "../agent/mcp-control.js";
import { type MemoryPort, quickNote } from "../agent/memory-port.js";
import { buildRegistry } from "../agent/registry.js";
import { makeSubagentTool } from "../agent/subagent-tool.js";
import { makeVerifyPort } from "../agent/verify-port.js";
import { makeWorkspaceContextPort } from "../agent/workspace-context-port.js";
import type { WorkspaceSettings } from "../agent/workspace-settings.js";
import { effortAliasNote } from "../commands/args.js";
import type { FleetRow } from "../render/fleet.js";
import {
  attachImageFile,
  captureClipboardImage,
  downscaleForWindow,
  looksLikeImagePath,
  normalizePastedText,
} from "./capture.js";
import { ActivityLine } from "./components/ActivityLine.js";
import {
  Approval,
  type ApprovalDecision,
  type ApprovalRequest,
  defaultApprovalSel,
  resolveApprovalKey,
} from "./components/Approval.js";
import { Banner } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { EffortPicker } from "./components/EffortPicker.js";
import { FilePicker } from "./components/FilePicker.js";
import { Goal } from "./components/Goal.js";
import { HistorySearch } from "./components/HistorySearch.js";
import { KeyPrompt } from "./components/KeyPrompt.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { Plan } from "./components/Plan.js";
import { Question, type QuestionState } from "./components/Question.js";
import { type SkillRow, SkillsBrowser } from "./components/SkillsBrowser.js";
import {
  SLASH_COMMANDS,
  type SlashCommand,
  SlashPalette,
  matchSlash,
} from "./components/SlashPalette.js";
import { StatusLine } from "./components/StatusLine.js";
import { Thinking } from "./components/Thinking.js";
import { Transcript, TranscriptRow } from "./components/Transcript.js";
import { WaveSummary } from "./components/WaveSummary.js";
import {
  clampCursor,
  composerTextWidth,
  cursorGoalCol,
  deleteBackAt,
  deleteForwardAt,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBack,
  insertAt,
  layoutRows,
  lineEnd,
  lineStart,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  wordLeft,
  wordRight,
} from "./editor.js";
import { fleetChanges } from "./fleet-diff.js";
import { fuzzyRank } from "./fuzzy.js";
import { helpText } from "./help.js";
import { activeMention, insertMention } from "./mention.js";
import { PromptQueue } from "./prompt-queue.js";
import { contextReport, tokens, usageReport } from "./reports.js";
import {
  type Activity,
  type AgentMode,
  EFFORTS,
  type Effort,
  MAX_GOAL_CHARS,
  type Permission,
  type PlanTask,
  type ViewState,
  appendNotice,
  clearTranscript,
  initialState,
  isSettled,
  nextPermission,
  optimisticEcho,
  reduce,
  setEffort,
  setGoal,
  setRequestedModel,
  shortName,
  toRuntimeMode,
  toggleAgentMode,
  withStop,
} from "./state.js";
import { AmbientTheme } from "./theme.js";
import { type AccountPort, useKeyPrompt } from "./use-key-prompt.js";
import { type HistoryPort, usePromptHistory } from "./use-prompt-history.js";
import { visionNote } from "./vision-note.js";

export interface AppDeps {
  client: ChatClient;
  makeWriter: (sessionId: string) => SessionWriter;
  capabilities?: CapabilityPort;
  agentMode: AgentMode;
  permission: Permission;
  effort: Effort;
  requestedModel: string;
  maxTurns: number;
  autoContinue?: boolean;
  maxAutoContinues?: number;
  /** The installed CLI version, shown in the splash. */
  version?: string;
  /** When a newer version is published: its version + the install-appropriate update command — drives the
   *  upgrade nudge in the splash. */
  update?: { latest: string; command: string };
  cwd: string;
  workspaceRoot: string;
  fleet?: FleetRow[];
  initialTask?: string;
  /** A north-star goal to start with (e.g. restored on `amb resume`). Shows in the pinned goal line + is
   *  threaded into every run. */
  initialGoal?: string;
  /** Session grants seeded from the config allowlist — those tools are auto-allowed without prompting. */
  initialGrants?: Grant[];
  /** Tools from the user's connected MCP servers (Claude + Codex config), registered per run. */
  mcpTools?: ToolDefinition[];
  /** Live getter for MCP tools — MCP connects in the BACKGROUND (so the UI renders instantly), so a run reads
   *  the tools available RIGHT NOW rather than a snapshot from mount time (empty until the servers finish). */
  getMcpTools?: () => ToolDefinition[];
  /** Skill counts for the `/skills` summary (loaded at the CLI edge; the App never touches the filesystem). */
  skillsInfo?: { total: number; pinned: number };
  /** Full skill rows for the interactive `/skills` browser (loaded at the CLI edge). */
  skills?: SkillRow[];
  /** Account effects for the in-app key flow (/login, /logout, a rejected or revoked key). */
  account?: AccountPort;
  /** Fetch the fleet as it is right now (keeps the model list live while the TUI is open). */
  refreshFleet?: () => Promise<FleetRow[] | undefined>;
  /** Pin/unpin a skill from the browser — writes the pin list at the edge; returns the new pinned state. */
  onTogglePin?: (name: string) => boolean;
  /** Prompt history for ↑/↓ recall and Ctrl+R search, persisted at the edge per workspace. */
  history?: HistoryPort;
  /** The workspace's files for the `@` picker (listed at the edge, on first use). */
  listFiles?: () => Promise<string[]>;
  /** Project and personal memory notes: `# note`, /memory. */
  memory?: MemoryPort;
  /** The session's MCP servers: status for /mcp, and sign-in with /mcp login. */
  mcp?: Pick<McpControl, "status" | "login" | "promptCommands" | "expandPrompt">;
  /** Include the user's global Claude Code / Codex instruction files (config `claudeSettings`). */
  userInstructions?: boolean;
  /** This workspace's hooks and permission rules: applied per run, listed by /hooks and /permissions. */
  settings?: WorkspaceSettings;
}

type Action =
  | { t: "event"; ev: NewEvent; at?: number }
  | { t: "stop"; stopReason: string }
  | { t: "agentMode"; agentMode: AgentMode }
  | { t: "permission"; permission: Permission }
  | { t: "effort"; effort: Effort }
  | { t: "model"; model: string }
  | { t: "notice"; level: "info" | "warn" | "error"; text: string }
  | { t: "echo"; text: string }
  | { t: "toggleThinking" }
  | { t: "goal"; text: string }
  | { t: "clear"; fresh?: boolean }
  | { t: "activity"; activity?: Activity }
  | { t: "compacted"; before: number; after: number };

function appReducer(state: ViewState, action: Action): ViewState {
  switch (action.t) {
    case "event":
      return reduce(state, action.ev, action.at);
    case "stop":
      return withStop(state, action.stopReason);
    case "agentMode":
      return { ...state, status: { ...state.status, agentMode: action.agentMode } };
    case "permission":
      return { ...state, status: { ...state.status, permission: action.permission } };
    case "effort":
      return setEffort(state, action.effort);
    case "model":
      return setRequestedModel(state, action.model);
    case "goal":
      return setGoal(state, action.text);
    case "notice":
      return appendNotice(state, action.level, action.text);
    case "echo":
      return optimisticEcho(state, action.text);
    case "toggleThinking": {
      // Flip it AND leave a clear trace so toggling always gives visible feedback. The flightline also shows
      // a persistent `think` marker while on.
      const next = !state.showThinking;
      return appendNotice(
        { ...state, showThinking: next },
        "info",
        `reasoning view ${next ? "ON — the model's thinking will show as it works" : "OFF"}`,
      );
    }
    case "activity":
      return { ...state, status: { ...state.status, activity: action.activity } };
    case "compacted": {
      // Room again: the fill warnings may fire afresh, and "in use" drops by what the summary saved. The
      // receipt says how full the context is now (the gauge also counts the system prompt and tools, so its
      // percentage is a little above the conversation's own tokens).
      const was = state.status.promptEstimate;
      const now = was !== undefined ? Math.max(0, was - (action.before - action.after)) : undefined;
      const window = state.status.contextWindow;
      const pct = (n: number) => `${Math.round((n / (window ?? 1)) * 100)}%`;
      const fill =
        was !== undefined && now !== undefined && window
          ? ` · context ${pct(was)} → ${pct(now)}`
          : "";
      return appendNotice(
        {
          ...state,
          contextWarned: undefined,
          status: { ...state.status, ...(now !== undefined ? { promptEstimate: now } : {}) },
        },
        "info",
        `compacted the conversation · ${tokens(action.before)} → ${tokens(action.after)} tokens${fill}`,
      );
    }
    case "clear":
      // A fresh conversation (idle /clear) also retires the plan; a mid-run clear only wipes the screen.
      return action.fresh
        ? {
            ...clearTranscript(state),
            plan: [],
            contextWarned: undefined,
            // A fresh conversation starts its token counts from zero too.
            status: {
              ...state.status,
              usage: undefined,
              tokensUsed: undefined,
              // Nothing is in the (empty) conversation yet, and the last run's outcome belongs to the old one.
              promptEstimate: undefined,
              stopReason: undefined,
            },
          }
        : clearTranscript(state);
  }
}

/** Rows the full splash banner takes (globe + wordmark, tagline, fleet line, rule, margins). */
const FULL_BANNER_ROWS = 15;
/** Rows under the banner on the idle screen: mode label, composer box, hint line and status line. */
const COMPOSER_ROWS = 8;

/** Most lines of launch notes that may sit under the splash banner. */
const SPLASH_NOTE_LINES = 4;

/** Most matches the `@` picker keeps (it shows a scrolling window of them). */
const FILE_PICKER_ROWS = 50;

/** Runs at least this long ring the terminal bell when they finish. */
const BELL_AFTER_MS = 30_000;

/** The terminal bell (most terminals badge the tab or notify when unfocused). AMBIENT_BELL=0 silences it. */
function ring(): void {
  if (process.env.AMBIENT_BELL === "0" || !process.stdout.isTTY) return;
  process.stdout.write("\x07");
}

/** The instruction that executes the SAVED plan ("adhere to it"). Called only for an explicit empty-Enter
 *  in BUILD mode; the steps are one-line labels (sanitized in parsePlan) referenced back to the model. */
function withPlan(plan: PlanTask[]): string {
  const list = plan.map((t, i) => `${i + 1}. [${t.status}] ${t.text}`).join("\n");
  return `Execute the plan you prepared (mark each step done as you complete it):\n${list}`;
}

export function App(deps: AppDeps): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  // The reasoning level the last run actually used, so a short "continue" keeps it under `auto`.
  const lastEffortRef = useRef<ReasoningLevel | undefined>(undefined);
  const [state, dispatch] = useReducer(
    appReducer,
    initialState({
      agentMode: deps.agentMode,
      permission: deps.permission,
      effort: deps.effort,
      requestedModel: deps.requestedModel,
      ...(deps.initialGoal ? { goal: deps.initialGoal } : {}),
    }),
  );
  useEffect(() => {
    lastEffortRef.current = state.status.resolvedEffort;
  }, [state.status.resolvedEffort]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0); // caret offset into `input` (composer editing)
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  // The open questionnaire (backs the `ask_user` tool), or null when none is pending.
  const [question, setQuestion] = useState<QuestionState | null>(null);
  // Images pending on the NEXT message (Ctrl+V / drag-drop / /attach). Ref mirror for synchronous key handling.
  const [attachments, setAttachmentsState] = useState<ImageAttachment[]>([]);
  const [fleet, setFleet] = useState(deps.fleet);
  const fleetRef = useRef(deps.fleet);
  // Keep the model list live: refresh in the background while idle (and whenever the picker opens), and say
  // when models join or leave the fleet — the catalog changes without the CLI needing an update.
  const refreshFleet = useCallback(async () => {
    const next = await deps.refreshFleet?.().catch(() => undefined);
    if (!next) return;
    for (const text of fleetChanges(fleetRef.current ?? [], next)) {
      dispatch({ t: "notice", level: "info", text });
    }
    fleetRef.current = next;
    setFleet(next);
  }, [deps]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!busyRef.current) void refreshFleet();
    }, 60_000);
    return () => clearInterval(timer);
  }, [refreshFleet]);
  // The picker lists EVERY model, ready ones first. The catalog's readiness flag is a hint (flagged models
  // have been seen serving), so a flagged one stays selectable and is marked; a truly down one fails over.
  const pickerFleet = useMemo(() => {
    const rank = (a: FleetRow["avail"]) => (a === "ready" ? 0 : a === "unknown" ? 1 : 2);
    return [...(fleet ?? [])].sort((a, b) => rank(a.avail) - rank(b.avail));
  }, [fleet]);
  const [runActive, setRunActive] = useState(false);
  const [queued, setQueued] = useState<string[]>([]);
  const [slashSel, setSlashSel] = useState(0);
  // The `@` file picker: the workspace file list (loaded on first use), the highlighted row, and the mention
  // the user closed with Esc (so it stays closed until they start another one).
  const [, setFiles] = useState<string[] | undefined>(undefined); // re-render once the list arrives
  const filesRef = useRef<string[] | undefined>(undefined);
  const filesLoadingRef = useRef(false);
  /** The last query's matches (the list is re-read on every render, and ranking 50k paths isn't free). */
  const fileMatchCacheRef = useRef<
    { query: string; files: string[]; matches: string[] } | undefined
  >(undefined);
  const [fileSel, setFileSel] = useState(0);
  const fileSelRef = useRef(0);
  const [, setMentionClosedAt] = useState<number | undefined>(undefined);
  const mentionClosedRef = useRef<number | undefined>(undefined);
  // Bumped by /clear to remount <Static> after the screen + scrollback are wiped.
  const [staticEpoch, setStaticEpoch] = useState(0);
  /** How many transcript items <Static> has printed this epoch (it only ever grows until /clear). */
  const committedRef = useRef(0);
  // The in-app key flow. A run that fails because Ambient rejected the key (revoked or mistyped) opens the
  // key panel and re-runs that task once a working key is saved; /login opens it on demand.
  const keyNotice = useCallback(
    (level: "info" | "warn" | "error", text: string) => dispatch({ t: "notice", level, text }),
    [],
  );
  const keyRerun = useCallback(
    (text: string, attachments: ImageAttachment[]) => void runTaskRef.current?.(text, attachments),
    [],
  );
  const isBusy = useCallback(() => busyRef.current, []);
  const keyFlow = useKeyPrompt(deps.account, keyNotice, keyRerun, isBusy);
  const keyFlowRef = useRef(keyFlow);
  keyFlowRef.current = keyFlow;
  const authRejectedRef = useRef(false);
  // Whether the current run executed any tool — decides how a run that died on a rejected key is retried.
  const toolsRanRef = useRef(false);
  // Set when a session's FIRST run died on a rejected key before doing anything: its only logged turn is that
  // failed attempt, so the retry must not rebuild context from the log (it would carry the task twice).
  const skipLogReplayRef = useRef(false);
  // A model chosen while a run is flying — handed to the agent at its next turn boundary, then cleared.
  const pendingSwitchRef = useRef<string | undefined>(undefined);
  const sessionImagesRef = useRef<ImageAttachment[]>([]);
  // One workspace port per conversation: its repo map stays fixed so the system prompt stays cacheable.
  const workspacePortRef = useRef(
    makeWorkspaceContextPort(undefined, {
      stableRepoMap: true,
      userInstructions: deps.userInstructions === true,
    }),
  );
  // Discover the user's existing Claude/Codex slash commands ONCE — their names join the palette, their
  // bodies (with $ARGUMENTS/$1 expansion) run as a task on dispatch.
  const customCommands = useMemo(() => {
    const palette: SlashCommand[] = [];
    const bodies = new Map<string, CustomCommand>();
    try {
      for (const c of discoverCommands(deps.workspaceRoot)) {
        const name = `/${c.name}`;
        palette.push({
          name,
          desc: c.description ?? "custom command",
          ...(c.argumentHint ? { args: c.argumentHint } : {}),
        });
        bodies.set(name, c);
      }
    } catch {
      /* best-effort — a bad command dir never breaks the TUI */
    }
    // Skills run as `/skill-name [args]` too (unless a skill opts out, or a command already has the name).
    const taken = new Set([...SLASH_COMMANDS.map((c) => c.name), ...bodies.keys()]);
    for (const sk of deps.skills ?? []) {
      const name = `/${sk.name}`;
      if (sk.userInvocable === false || taken.has(name) || !/^[a-zA-Z0-9_.:-]+$/.test(sk.name))
        continue;
      taken.add(name);
      palette.push({
        name,
        desc: `skill · ${sk.description}`,
        ...(sk.argumentHint ? { args: sk.argumentHint } : {}),
      });
      bodies.set(name, {
        name: sk.name,
        body: `Use the "${sk.name}" skill: load it with the skill tool and follow its instructions.\n\n$ARGUMENTS`,
        source: "user",
      });
    }
    return { palette, bodies };
  }, [deps.workspaceRoot, deps.skills]);
  // MCP prompts join the menu as `/mcp__server__prompt` once their servers connect (in the background).
  const commandPalette = [...customCommands.palette, ...(deps.mcp?.promptCommands() ?? [])];
  const [picker, setPickerState] = useState<"model" | "effort" | "skills" | null>(null);
  const [pickerSel, setPickerSelState] = useState(0);
  const [approvalSel, setApprovalSelState] = useState(0);
  const [tick, setTick] = useState(0);
  // Whether the LIVE subagent wave is expanded (shows each child's tool rows + streamed prose) — collapsed
  // by default so a big wave can't fill the screen; ↓ / Ctrl+O expands, ↑ collapses.
  const [subagentExpanded, setSubagentExpanded] = useState(false);
  // Bumped on a terminal resize so width/rows (read fresh each render) reflow even while idle — Ink's
  // useStdout does NOT re-render on resize, so without this a resize left content overflowing the new width.
  const [, setResizeTick] = useState(0);
  const runStartRef = useRef(0);
  const phaseStartRef = useRef(0);
  const waveStartRef = useRef(0); // stamped when a subagent wave first appears (for its elapsed clock)

  // Skills browser (/skills): filter text + a LIVE pinned set (toggled with Tab, written at the edge). The
  // filtered+sorted rows are held in a ref too, so the key handler can navigate them synchronously.
  const [skillFilter, setSkillFilterState] = useState("");
  const skillFilterRef = useRef("");
  const setSkillFilter = (f: string): void => {
    skillFilterRef.current = f;
    setSkillFilterState(f);
  };
  const [pinnedSet, setPinnedSet] = useState<Set<string>>(
    () => new Set((deps.skills ?? []).filter((s) => s.pinned).map((s) => s.name)),
  );
  const filteredSkills = useMemo(() => {
    const all = (deps.skills ?? []).map((s) => ({ ...s, pinned: pinnedSet.has(s.name) }));
    const f = skillFilter.trim().toLowerCase();
    const matched =
      f.length === 0
        ? all
        : all.filter(
            (s) => s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f),
          );
    return matched.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        a.source.localeCompare(b.source) ||
        a.name.localeCompare(b.name),
    );
  }, [deps.skills, skillFilter, pinnedSet]);
  const filteredSkillsRef = useRef<SkillRow[]>([]);
  filteredSkillsRef.current = filteredSkills;

  const controllerRef = useRef<AbortController | null>(null);
  const approvalResolver = useRef<((d: "allow-once" | "allow-session" | "deny") => void) | null>(
    null,
  );
  const busyRef = useRef(false);
  const inputRef = useRef("");
  const hist = usePromptHistory(deps.history);
  const cursorRef = useRef(0); // read synchronously by the key handler (mirrors the input-ref pattern)
  const goalColRef = useRef<number | undefined>(undefined); // sticky column across a run of ↑/↓ moves
  const queueRef = useRef<{ text: string; attachments: ImageAttachment[] }[]>([]);
  // Text messages the user sent WHILE a run is in flight — the running agent pulls these at each turn
  // boundary and injects them (steering). Anything left when the run ends drains as a follow-up turn.
  const steerRef = useRef<string[]>([]);
  // Set when you press Enter on an empty line while messages wait on a subagent wave: the wave wraps up and
  // reports now, so the agent reads your message sooner. Cleared when a run starts.
  const hurryRef = useRef(false);
  const cancellingRef = useRef(false);
  const agentModeRef = useRef<AgentMode>(deps.agentMode);
  const permissionRef = useRef<Permission>(deps.permission);
  const effortRef = useRef<Effort>(deps.effort);
  const modelRef = useRef<string>(deps.requestedModel);
  const planRef = useRef<PlanTask[]>([]);
  // True ONLY right after a PLAN-mode run produced a plan that's awaiting the user's approve/revise — so the
  // banner + the one-key approve gesture fire only on a FRESH plan, never a stale one (a build run that hit
  // maxTurns, or a plan kept across /clear). Cleared when any run starts and on /clear. `state` drives the
  // banner render; the ref lets the synchronous key handler read it without a frame's lag.
  const [planReviewPending, setPlanReviewPending] = useState(false);
  const planReviewPendingRef = useRef(false);
  // Stable (empty deps: closes over only a setState + a ref, both stable) so callbacks that call it — runTask,
  // the emit consumer — can depend on it without being recreated every render.
  const setPlanReview = useCallback((v: boolean) => {
    planReviewPendingRef.current = v;
    setPlanReviewPending(v);
  }, []);
  // The LIVE conversation carried across messages in this session: the non-system messages the last run
  // returned (full tool bodies + reasoning, already compacted by the runtime if it grew). The next run
  // continues this real array instead of a lossy text reconstruction — so the runtime's own compaction
  // manages the whole session and the agent stops forgetting on long threads. Reset by /clear (new session).
  const conversationRef = useRef<Msg[]>([]);
  // The live north-star goal (synchronously read by runTask) + the last goal persisted to the CURRENT
  // session's log, so a changed goal is recorded once per session for `amb resume` to restore.
  const goalRef = useRef<string>(deps.initialGoal ?? "");
  const persistedGoalRef = useRef<string | undefined>(undefined);
  const pickerRef = useRef<"model" | "effort" | "skills" | null>(null);
  const pickerSelRef = useRef(0);
  const approvalSelRef = useRef(0); // selection index read SYNCHRONOUSLY by the key handler (state lags a frame)
  // The questionnaire resolver + a live mirror of its state (refs so the key handler mutates synchronously —
  // React state lags a frame, and a fast typist / quick Enter must never act on stale option/text state).
  const questionResolver = useRef<((res: AskResponse) => void) | null>(null);
  const questionRef = useRef<QuestionState | null>(null);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  const capturingRef = useRef(false); // debounce overlapping Ctrl+V while a capture is in flight
  // ONE grants array for the whole TUI session, so "allow for this session" actually persists across turns
  // (each turn is its own Agent.run; without a stable array the grant would be discarded every prompt).
  // Seeded from the config allowlist so those tools are pre-approved for the launch.
  const sessionGrantsRef = useRef<Grant[]>(deps.initialGrants ? [...deps.initialGrants] : []);
  // ONE session id + writer per TUI launch (NOT per submit): each turn is its own Agent.run, but they share a
  // single durable log so history/resume is coherent — and the SAME writer instance, because SessionWriter
  // chains seq/prevChecksum per instance (a fresh writer on the same file would restart seq=0 and break the
  // hash chain). Reset to null by /clear so a cleared screen starts a genuinely new conversation.
  const sessionIdRef = useRef<string | null>(null);
  const writerRef = useRef<SessionWriter | null>(null);
  const runTaskRef = useRef<((task: string, attach?: ImageAttachment[]) => Promise<void>) | null>(
    null,
  );
  const MAX_ATTACHMENTS = 4;
  const setAttachments = (next: ImageAttachment[]): void => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  };
  // Add an attachment (deduped by sha256, capped) and tell the user.
  const addAttachment = (att: ImageAttachment): void => {
    if (attachmentsRef.current.some((a) => a.sha256 === att.sha256)) return; // same image already pending
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      dispatch({
        t: "notice",
        level: "warn",
        text: `at most ${MAX_ATTACHMENTS} images per message`,
      });
      return;
    }
    setAttachments([...attachmentsRef.current, att]);
    const kb = Math.max(1, Math.round(att.bytes / 1024));
    dispatch({ t: "notice", level: "info", text: `image attached (${kb} KB)` });
  };
  // Ctrl+V / paste-a-path capture — async, debounced; a failure is a calm dim notice, never a crash.
  const captureImage = async (): Promise<void> => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    try {
      const res = await captureClipboardImage();
      if (res.ok) addAttachment(res.attachment);
      else dispatch({ t: "notice", level: "info", text: res.reason });
    } finally {
      capturingRef.current = false;
    }
  };

  const setPicker = (p: "model" | "effort" | "skills" | null): void => {
    pickerRef.current = p;
    setPickerState(p);
  };
  const setPickerSel = (n: number): void => {
    pickerSelRef.current = n;
    setPickerSelState(n);
  };
  const setApprovalSel = (n: number): void => {
    approvalSelRef.current = n;
    setApprovalSelState(n);
  };

  const settingsRef = useRef(deps.settings);
  // What a session's runs share: folders a loaded skill made readable, and folders whose instructions the
  // agent has already been given (so a subfolder's AGENTS.md comes once per conversation, not per message).
  const runStateRef = useRef(newRunState());
  // Background commands: say when one finishes, and stop them all when the session ends — even an abrupt
  // exit, since they run in their own process groups and would otherwise outlive ambient.
  const [jobsEpoch, setJobsEpoch] = useState(0);
  useEffect(() => {
    void jobsEpoch;
    const { jobs, tasks } = runStateRef.current;
    const off = jobs.onFinish((job) => {
      dispatch({
        t: "notice",
        level: job.exitCode === 0 ? "info" : "warn",
        text: `Background ${job.id} finished${job.exitCode === null ? " (stopped)" : ` (exit ${job.exitCode})`}: ${job.command.slice(0, 80)}`,
      });
    });
    const stop = () => {
      jobs.stopAll();
      tasks.stopAll(); // background subagents too
    };
    process.once("exit", stop);
    return () => {
      off();
      process.removeListener("exit", stop);
      stop();
    };
  }, [jobsEpoch]);
  // A project whose own settings (hooks, allow rules, MCP servers) wait for the user's OK says so up front.
  useEffect(() => {
    if ((settingsRef.current?.untrustedCount() ?? 0) > 0) {
      dispatch({
        t: "notice",
        level: "info",
        text: "Project hooks, rules, MCP servers and verify script are off until you review them: /trust",
      });
    }
  }, []);
  // One prompt on screen at a time for the whole session: the agent, its subagents and background waves can
  // all ask at once, and the overlay holds a single answer slot. Prompts wait their turn; one still waiting
  // when its run is cancelled settles without being shown.
  const promptsRef = useRef(new PromptQueue());
  /** When the current approval prompt appeared (keys right after it are ignored). */
  const approvalShownAtRef = useRef(0);
  // Tools you allowed "for this session" during the current run: prompts for them that were already waiting
  // their turn take that answer instead of asking again (the grant covers the tool the same way).
  const sessionAllowedRef = useRef(new Set<string>());
  const approve = useCallback<RunOptions["approve"]>((req) => {
    // "Bypass session" (chosen from an earlier approval, or /bypass) auto-allows the rest of THIS run without
    // a prompt — the current run's mode was snapshotted at start, so decide() still asks; we short-circuit here.
    if (permissionRef.current === "bypass") return Promise.resolve("allow-once");
    return promptsRef.current.run(() => showApproval(req), "deny" as const);
  }, []);
  const showApproval = (
    req: Parameters<RunOptions["approve"]>[0],
  ): Promise<"allow-once" | "allow-session" | "deny"> => {
    return new Promise((settle) => {
      if (permissionRef.current === "bypass") {
        settle("allow-once");
        return;
      }
      if (sessionAllowedRef.current.has(req.toolName)) {
        settle("allow-session");
        return;
      }
      const resolve = (d: "allow-once" | "allow-session" | "deny") => {
        if (d === "allow-session") sessionAllowedRef.current.add(req.toolName);
        settle(d);
      };
      approvalResolver.current = resolve;
      approvalShownAtRef.current = Date.now();
      ring(); // the agent is waiting on you
      void fireAndForget(
        settingsRef.current?.hooksPort(() => sessionIdRef.current ?? ""),
        "Notification",
        {
          message: `ambient needs your permission to use ${req.toolName}`,
        },
      );
      // Pre-arm the selection: allow-once for a normal ask, but DENY when the request was escalated for risk —
      // a muscle-memory Enter must never approve something we flagged as dangerous. (ref + state, no closure.)
      const seed = defaultApprovalSel(req.decision.reason);
      approvalSelRef.current = seed;
      setApprovalSelState(seed);
      setPending({
        toolName: req.toolName,
        args: req.args,
        effects: req.effects,
        decision: req.decision,
      });
    });
  };

  // Push a questionnaire (both the ref the key handler reads and the state that renders).
  const setQuestionState = (q: QuestionState | null): void => {
    questionRef.current = q;
    setQuestion(q);
  };
  // The interactive-question port (backs `ask_user`): open the overlay and resolve when the human submits/skips.
  // Inlines the ref+setState (rather than calling setQuestionState) so this memoized callback depends only on
  // stable refs + the state setter — no per-render function in its closure.
  const ask = useCallback<NonNullable<RunOptions["ask"]>>((req: AskRequest) => {
    return promptsRef.current.run(
      () =>
        new Promise<AskResponse>((resolve) => {
          questionResolver.current = resolve;
          const q: QuestionState = { req, cursor: 0, selected: new Set<number>(), text: "" };
          questionRef.current = q;
          setQuestion(q);
        }),
      { selected: [], cancelled: true },
    );
  }, []);
  // Settle the open question. `cancelled` (Esc / abort) tells the agent to proceed on its own judgment.
  const finishQuestion = (res: AskResponse): void => {
    const resolve = questionResolver.current;
    questionResolver.current = null;
    setQuestionState(null);
    resolve?.(res);
  };
  const submitQuestion = (): void => {
    const q = questionRef.current;
    if (!q) return;
    const multi = q.req.multiSelect === true;
    const opts = q.req.options ?? [];
    // Single-select: the ▸ cursor IS the selection (when there are options). Multi: the toggled set.
    const idxs = multi ? [...q.selected].sort((a, b) => a - b) : opts.length > 0 ? [q.cursor] : [];
    const selected = idxs.map((i) => opts[i]?.label).filter((l): l is string => Boolean(l));
    finishQuestion({ selected, ...(q.text.trim() ? { text: q.text.trim() } : {}) });
  };

  const abortRun = useCallback(() => {
    cancellingRef.current = true;
    // Don't SILENTLY drop pending messages on cancel (the user noticed queued items just vanished) —
    // clear them but say so.
    const dropped = steerRef.current.length + queueRef.current.length;
    queueRef.current = [];
    steerRef.current = [];
    setQueued([]);
    if (dropped > 0) {
      dispatch({
        t: "notice",
        level: "info",
        text: `cancelled — discarded ${dropped} queued message${dropped === 1 ? "" : "s"}`,
      });
    }
    controllerRef.current?.abort();
    promptsRef.current.settleWaiting(); // prompts still waiting their turn settle unseen
    const resolve = approvalResolver.current;
    if (resolve) {
      approvalResolver.current = null;
      setPending(null);
      resolve("deny");
    }
    // A run cancelled while a question is open must settle it (cancelled) so the tool promise never dangles.
    const qResolve = questionResolver.current;
    if (qResolve) {
      questionResolver.current = null;
      questionRef.current = null;
      setQuestion(null);
      qResolve({ selected: [], cancelled: true });
    }
  }, []);

  const runTask = useCallback(
    async (task: string, attach: ImageAttachment[] = []) => {
      if (busyRef.current) return;
      busyRef.current = true;
      pendingSwitchRef.current = undefined; // a switch picked during an earlier run already set modelRef
      runStartRef.current = Date.now();
      hurryRef.current = false;
      sessionAllowedRef.current.clear();
      setTick(0);
      setRunActive(true);
      setPlanReview(false); // a run is starting — the previous plan (if any) is no longer awaiting review
      authRejectedRef.current = false;
      toolsRanRef.current = false;
      // One session id + writer for the whole TUI launch (minted lazily on the first turn, reset by /clear).
      if (!sessionIdRef.current || !writerRef.current) {
        sessionIdRef.current = newSessionId();
        writerRef.current = deps.makeWriter(sessionIdRef.current);
        persistedGoalRef.current = undefined; // a fresh session log hasn't recorded the goal yet
        conversationRef.current = []; // a fresh session starts with no carried-forward conversation
        sessionImagesRef.current = []; // image numbers restart with the session
        workspacePortRef.current = makeWorkspaceContextPort(undefined, {
          stableRepoMap: true,
          userInstructions: deps.userInstructions === true,
        });
      }
      // The conversation as it stood before this run (after any fresh-session reset above) — restored if the
      // run dies on a rejected key before doing anything, so the retry sends the task once instead of twice.
      const conversationBefore = conversationRef.current;
      const imagesBefore = sessionImagesRef.current;
      const sessionId = sessionIdRef.current;
      const writer = writerRef.current;
      // Record the current north-star into THIS session's log if it changed since we last did, so `amb resume`
      // restores it. Written before the run so it precedes turn.started in the durable order.
      if (goalRef.current !== (persistedGoalRef.current ?? "")) {
        writer.append({
          kind: "goal.set",
          schemaVersion: 1,
          sessionId,
          text: goalRef.current,
        } as NewEvent);
        persistedGoalRef.current = goalRef.current;
      }
      // Conversational continuity. Once this session has run at least once we carry the REAL message array
      // forward (lossless, runtime-compacted) — the strong path. Only the FIRST run of a session (or a
      // process that resumed an on-disk session with no live Msg[]) falls back to the lossy text
      // reconstruction, which the runtime budgets/trims to the served window.
      const carryForward = conversationRef.current.length > 0;
      const priorContext =
        carryForward || skipLogReplayRef.current
          ? ""
          : reconstructTranscript(
              readSession(sessionId).events,
              (t) => guardUntrustedResult(t).text,
            );
      const controller = new AbortController();
      controllerRef.current = controller;
      // Snapshot the axes for THIS run (a mid-run Tab/Shift+Tab must not change what's already flying).
      const agentMode = agentModeRef.current;
      const runtimeMode = toRuntimeMode(agentMode, permissionRef.current);
      // The saved plan is ONLY executed by an explicit empty-Enter ("build the plan") — a typed task is a
      // NEW request and runs as-is, never merged with the old plan. An IMAGE-ONLY send (empty text + an
      // attachment) is a real "look at this" request, NOT plan execution, so it must not be hijacked.
      const finalTask =
        agentMode === "build" && task === "" && attach.length === 0
          ? withPlan(planRef.current)
          : task;
      // Echo the message + show "Thinking" THE INSTANT the user submits — before the run's catalog fetch —
      // so pressing Enter never leaves a dead gap. The run's turn.started confirms this item in place.
      dispatch({ t: "echo", text: finalTask });

      try {
        // Shared durable-event sink: persist FIRST (validated), then dispatch to the reducer — so the UI never
        // shows an event that wasn't durably logged, and a write failure aborts + surfaces one way everywhere.
        const emit = createDurableEventSink({
          writer,
          consume: (ev: NewEvent) => {
            // A goal.set emitted mid-run (propose_goal_update, user-approved) is persisted by this sink.
            // Mirror it SYNCHRONOUSLY onto BOTH refs: the run-completion handler + a drained follow-up run
            // read goalRef/persistedGoalRef the instant the run ends, and the useEffect that mirrors state.goal
            // can lag a frame (React batching), which would silently revert the north-star into the durable
            // log. Apply the SAME transform the reducer's setGoal uses (trim + cap) so the refs never diverge
            // from state.goal and the run-start guard doesn't re-append a spurious goal.set.
            if (ev.kind === "goal.set") {
              const g = ev.text.trim().slice(0, MAX_GOAL_CHARS);
              goalRef.current = g;
              persistedGoalRef.current = g;
            }
            // Sync planRef SYNCHRONOUSLY as the model records/updates its plan. The run-completion handler
            // reads planRef the instant the run ends to decide whether to arm the review banner; the
            // useEffect that mirrors state.plan can lag a frame under React's batching, which would miss a
            // just-produced plan (parsePlanTasks is the SAME parser the reducer uses, so they never diverge).
            if (ev.kind === "tool.proposed" && ev.toolName === "plan") {
              const parsed = parsePlanTasks(ev.args);
              if (parsed) planRef.current = parsed;
            }
            if (ev.kind === "error" && ev.errorKind === "auth") authRejectedRef.current = true;
            if (ev.kind === "tool.result") toolsRanRef.current = true;
            dispatch({ t: "event", ev, at: Date.now() });
          },
          onWriteError: () => {
            controller.abort();
            dispatch({
              t: "event",
              ev: {
                kind: "error",
                schemaVersion: 1,
                sessionId,
                errorKind: "transport",
                message: "session log write failed — aborting",
              } as NewEvent,
            });
          },
        });

        // Downscale huge screenshots to a universal safe edge before send (bounds wire bytes; the agent bounds
        // TOKENS per the served window). Offload each image's bytes to the session object store (keyed by hash)
        // so a resumed session can rehydrate without the base64 living in the event log.
        const sized =
          attach.length > 0
            ? await Promise.all(attach.map((a) => downscaleForWindow(a, IMAGE_EDGE_HIGH)))
            : [];
        for (const a of sized) saveObject(sessionId, a.dataBase64);

        // This run's images join the session's numbered list only if the run is kept (below) — a run cancelled
        // before it starts, or retried after a key problem, must not shift the numbers ask_vision uses.
        const sessionImages = [...sessionImagesRef.current, ...sized];
        // Hooks are re-read per run, so an edited settings file or a newly trusted project applies right away.
        const hooks = deps.settings?.hooksPort(() => sessionId);
        const permissionRules = deps.settings?.rules();
        const opts: RunOptions = {
          sessionId,
          mode: runtimeMode,
          requestedModel: modelRef.current,
          maxTurns: deps.maxTurns,
          autoContinue: deps.autoContinue ?? true,
          maxAutoContinues: deps.maxAutoContinues ?? 3,
          cwd: deps.cwd,
          workspaceRoot: deps.workspaceRoot,
          signal: controller.signal,
          emit,
          approve,
          ask, // the `ask_user` tool opens the questionnaire overlay through this
          // Mid-run STEER: the running agent pulls any messages the user sent while it was working and
          // injects them at the next turn boundary. Consumed items leave the visible queue.
          steer: () => {
            if (steerRef.current.length === 0) return [];
            const msgs = steerRef.current;
            steerRef.current = [];
            hurryRef.current = false; // read — a later wave in this run isn't cut short
            setQueued([...queueRef.current.map((q) => q.text)]);
            return msgs;
          },
          grants: sessionGrantsRef.current, // persist "allow for this session" across turns
          ...(goalRef.current ? { goal: goalRef.current } : {}), // the session north-star, pinned in the anchor
          // The lossless live conversation (preferred) OR the reconstruction (first run / resume) — never both.
          ...(carryForward ? { priorMessages: conversationRef.current } : {}),
          ...(priorContext ? { resumeContext: priorContext } : {}),
          // Pin the outstanding plan into the anchor so a multi-message session keeps adhering to it.
          ...(planRef.current.length > 0 ? { plan: { tasks: planRef.current } } : {}),
          ...(sized.length > 0 ? { attachments: sized } : {}),
          // Every image attached this session, numbered from 1 — a model that can't see images can ask a
          // vision model about any of them later (ask_vision).
          ...(sessionImages.length > 0 ? { sessionImages } : {}),
          capabilities: deps.capabilities,
          workspace: workspacePortRef.current,
          verify: makeVerifyPort(
            deps.workspaceRoot,
            () => deps.settings?.projectTrusted() === true,
          ),
          checkpoint: (content) => saveObject(sessionId, content),
          artifact: (content) => saveObject(sessionId, content), // offload large tool outputs
          readArtifact: (handle) => readObject(sessionId, handle),
          loadImage: makeImageLoader(sessionId),
          effort: effortRef.current,
          ...(lastEffortRef.current ? { priorEffort: lastEffortRef.current } : {}),
          ...(hooks ? { hooks } : {}),
          ...(permissionRules ? { permissionRules } : {}),
          runState: runStateRef.current,
          nextModel: () => {
            const m = pendingSwitchRef.current;
            pendingSwitchRef.current = undefined;
            return m;
          },
        };

        // Build the registry with the `subagent` tool per-run, capturing THIS run's mode/approver/verify.
        // Read MCP tools LIVE (they connect in the background) so a run started once the servers are ready
        // picks them up, without blocking the UI at launch.
        const mcpTools = deps.getMcpTools?.() ?? deps.mcpTools;
        const registry = buildRegistry({
          ...(mcpTools && mcpTools.length > 0 ? { mcpTools } : {}),
          subagent: makeSubagentTool({
            presets: discoverAgents(deps.workspaceRoot),
            client: deps.client,
            workspace: opts.workspace,
            approve,
            parentMode: runtimeMode,
            ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
            ...(opts.verify ? { verify: opts.verify } : {}),
            ...(goalRef.current ? { goal: goalRef.current } : {}), // children inherit the north-star
            ...(hooks ? { hooks } : {}),
            ...(permissionRules ? { permissionRules } : {}),
            hurry: () => hurryRef.current,
            effort: effortRef.current,
            mcpTools: () => mcpTools ?? [],
            ...(opts.ask ? { ask: opts.ask } : {}),
          }),
        });

        const result = await new Agent(deps.client, registry).run(finalTask, opts);
        // Carry the real conversation forward (drop [0], the run's fresh system anchor — the next run rebuilds
        // it with the current goal/plan/repo-map). This is what makes the interactive session use the runtime's
        // own compaction instead of a lossy per-message reconstruction.
        if (result.messages && result.messages.length > 1) {
          conversationRef.current = result.messages.slice(1);
          skipLogReplayRef.current = false;
          // Includes images the agent looked at itself (view_image), so numbering stays the same next time.
          sessionImagesRef.current = [...(result.sessionImages ?? sessionImages)];
        }
        dispatch({ t: "stop", stopReason: result.stopReason });
        // A long run finishing is worth a heads-up if you've switched to another window.
        if (
          result.stopReason !== "cancelled" &&
          Date.now() - runStartRef.current >= BELL_AFTER_MS
        ) {
          ring();
        }
        // The run may have created or removed files — the @ picker lists them afresh next time.
        filesRef.current = undefined;
        filesLoadingRef.current = false;
      } catch (err) {
        // An UNEXPECTED throw (classified errors return a result and carry forward normally): we didn't get
        // this run's messages, so the carried conversation is now behind the durable log. Reset it to [] so the
        // NEXT message rebuilds from the event log (reconstruction), which still holds this failed turn — rather
        // than silently continuing on a stale conversation that's missing it.
        conversationRef.current = [];
        dispatch({ t: "stop", stopReason: "error" });
        dispatch({
          t: "event",
          ev: {
            kind: "error",
            schemaVersion: 1,
            sessionId,
            errorKind: "transport",
            message: err instanceof Error ? err.message : String(err),
          } as NewEvent,
        });
      } finally {
        controllerRef.current = null;
        busyRef.current = false;
        setRunActive(false);
        // The agent waits for its background subagents before answering, so any still running here were cut
        // off (cancelled, out of turns): stop them, and settle every prompt that was still waiting its turn.
        runStateRef.current.tasks.stopAll();
        promptsRef.current.settleWaiting();
        const resolve = approvalResolver.current;
        if (resolve) {
          approvalResolver.current = null;
          resolve("deny");
        }
        setPending(null);
        // Settle any dangling question so its tool promise never leaks past the run (parity with approvals).
        const qResolve = questionResolver.current;
        if (qResolve) {
          questionResolver.current = null;
          questionRef.current = null;
          qResolve({ selected: [], cancelled: true });
        }
        setQuestion(null);
        cancellingRef.current = false;
        // A PLAN-mode run that produced a plan: arm the review state. The composer then shows the SINGLE clear
        // enumerated approve/revise/keep-planning prompt (no duplicate scrollback notice — one affordance).
        if (agentModeRef.current === "plan" && planRef.current.some((t) => t.status !== "done")) {
          setPlanReview(true);
        }
        // Steer messages the agent didn't consume (it finished before the next turn boundary) run as a
        // follow-up turn; otherwise drain the next queued (attachment) message. Either way nothing is lost.
        // A rejected key pauses both: the key panel opens, and the same task re-runs once a key works.
        const leftoverSteer = steerRef.current;
        if (authRejectedRef.current) {
          authRejectedRef.current = false;
          // Mid-run messages wait in the queue (not injected into whatever runs next).
          if (leftoverSteer.length > 0) {
            steerRef.current = [];
            queueRef.current.unshift({ text: leftoverSteer.join("\n"), attachments: [] });
            setQueued(queueRef.current.map((q) => q.text));
          }
          // Nothing ran yet → retry the task as if it never happened. Tools already ran → keep what they did
          // and ask the model to pick up where it stopped, so nothing is executed twice.
          if (toolsRanRef.current) {
            keyFlowRef.current.open("rejected", { text: CONTINUE_AFTER_KEY, attachments: [] });
          } else {
            conversationRef.current = conversationBefore;
            sessionImagesRef.current = imagesBefore; // the retry attaches the same images again
            if (conversationBefore.length === 0) skipLogReplayRef.current = true;
            keyFlowRef.current.open("rejected", { text: task, attachments: attach });
          }
        } else if (leftoverSteer.length > 0) {
          steerRef.current = [];
          setQueued(queueRef.current.map((q) => q.text));
          void runTaskRef.current?.(leftoverSteer.join("\n"), []);
        } else {
          const next = queueRef.current.shift();
          if (next) {
            setQueued(queueRef.current.map((q) => q.text));
            void runTaskRef.current?.(next.text, next.attachments);
          }
        }
      }
    },
    [approve, ask, deps, setPlanReview],
  );
  runTaskRef.current = runTask;

  // Keep refs in sync for the queue drain + plan-adherence (React state lags a frame).
  useEffect(() => {
    planRef.current = state.plan;
  }, [state.plan]);
  // Keep the synchronously-read goalRef mirrored to state.goal — so a goal set by the `propose_goal_update`
  // tool (which drives state.goal via a goal.set event) reaches the NEXT run, just like the `/goal` command.
  useEffect(() => {
    goalRef.current = state.goal ?? "";
  }, [state.goal]);

  useEffect(() => {
    if (!runActive) return;
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, [runActive]);

  // Reflow on terminal resize (Ink's useStdout doesn't trigger a re-render on its own).
  useEffect(() => {
    const out = stdout;
    if (!out?.on) return;
    const onResize = () => setResizeTick((n) => n + 1);
    out.on("resize", onResize);
    return () => {
      out.off?.("resize", onResize);
    };
  }, [stdout]);

  // Reset the per-phase clock whenever the live activity verb changes (a thinking-duration timer).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the verb is the CHANGE TRIGGER, not a value used
  useEffect(() => {
    phaseStartRef.current = Date.now();
  }, [state.status.activity?.verb]);

  // Stamp the wave's start when its id first appears; clear it when the wave ends. Keeps the elapsed clock in
  // the view (a ref), so the reducer stays pure. Keyed on the wave ID by design (re-stamp only on begin/end/swap).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — keyed on state.wave?.id, not the object
  useEffect(() => {
    waveStartRef.current = state.wave ? Date.now() : 0;
  }, [state.wave?.id]);

  // On unmount (quit), abort any in-flight run so nothing keeps executing after the UI is gone.
  useEffect(() => () => controllerRef.current?.abort(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional run-once-on-mount
  useEffect(() => {
    const task = deps.initialTask?.trim();
    if (task) void runTask(task);
  }, []);

  // The single write choke-point for the composer buffer + caret. `nextCursor` defaults to the end of the
  // buffer, so every existing caller (clears, prefills, the failed-attach append) keeps its old behavior; only
  // the true edit sites pass an explicit caret. Clamps the caret so it can never land mid-surrogate/out of range.
  const setBuffer = (nextValue: string, nextCursor: number = nextValue.length): void => {
    inputRef.current = nextValue;
    cursorRef.current = clampCursor(nextValue, nextCursor);
    setInput(nextValue);
    setCursor(cursorRef.current);
    setSlashSel(0);
  };

  const openModelPicker = (): void => {
    void refreshFleet(); // the list updates in place if the fleet changed
    const list = pickerFleet;
    // No LIVE models (fleet fetch failed, or every model is cold) → don't open an empty no-op box; point at
    // the manual path (a cold model can still be chosen by id — the runtime substitutes a warm one).
    if (list.length === 0) {
      dispatch({
        t: "notice",
        level: "warn",
        text: "no live models right now — set one by id with /model <vendor/model-id>",
      });
      setBuffer("");
      return;
    }
    const idx = Math.max(
      0,
      list.findIndex((r) => r.id === modelRef.current),
    );
    setPickerSel(idx);
    setPicker("model");
    setBuffer("");
  };

  const openEffortPicker = (): void => {
    setPickerSel(Math.max(0, EFFORTS.indexOf(effortRef.current)));
    setPicker("effort");
    setBuffer("");
  };

  /** `/compact [focus]`: summarize the carried conversation now so the next message starts lighter. */
  const runCompact = async (focus: string): Promise<void> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || conversationRef.current.length === 0) {
      dispatch({ t: "notice", level: "info", text: "nothing to compact yet" });
      return;
    }
    busyRef.current = true;
    setRunActive(true);
    runStartRef.current = Date.now();
    dispatch({ t: "activity", activity: { verb: "Compacting the conversation" } });
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const compactHooks = deps.settings?.hooksPort(() => sessionId);
      const res = await compactNow({
        client: deps.client,
        conversation: conversationRef.current,
        // The model the next message will go to: the one picked, or (on auto) the one last served.
        model:
          modelRef.current !== AUTO_MODEL
            ? modelRef.current
            : (state.status.reportedModel ?? state.status.targetModel ?? modelRef.current),
        workspace: workspacePortRef.current,
        workspaceRoot: deps.workspaceRoot,
        sessionId,
        focus,
        signal: controller.signal,
        // The receipt below says what changed; the automatic-compaction notice would repeat it.
        emit: (ev) => {
          if (ev.kind !== "context.compacted") dispatch({ t: "event", ev, at: Date.now() });
        },
        ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
        ...(compactHooks ? { hooks: compactHooks } : {}),
      });
      if (controller.signal.aborted) {
        dispatch({ t: "notice", level: "info", text: "compaction cancelled — nothing changed" });
      } else if (res.ok) {
        conversationRef.current = res.messages;
        dispatch({ t: "compacted", before: res.before, after: res.after });
      } else {
        dispatch({ t: "notice", level: "info", text: res.reason });
      }
    } finally {
      controllerRef.current = null;
      cancellingRef.current = false;
      busyRef.current = false;
      setRunActive(false);
      dispatch({ t: "stop", stopReason: controller.signal.aborted ? "cancelled" : "complete" });
      // Anything typed while compacting runs now, in order (steers first, then queued messages).
      const typed = steerRef.current;
      steerRef.current = [];
      const next =
        typed.length > 0 ? { text: typed.join("\n"), attachments: [] } : queueRef.current.shift();
      setQueued(queueRef.current.map((q) => q.text));
      if (next && !controller.signal.aborted)
        void runTaskRef.current?.(next.text, next.attachments);
    }
  };

  /** Pick a model: the next run uses it, and a run in flight switches to it at its next step. */
  const chooseModel = (id: string): void => {
    modelRef.current = id;
    dispatch({ t: "model", model: id });
    if (busyRef.current) {
      pendingSwitchRef.current = id;
      dispatch({ t: "notice", level: "info", text: `switching to ${id} at the next step…` });
    } else {
      pendingSwitchRef.current = undefined;
      dispatch({ t: "notice", level: "info", text: `model → ${id}` });
    }
  };

  const runSlash = (command: SlashCommand, arg: string): void => {
    // Config commands change what the NEXT run does — refuse them mid-run so the flightline never
    // misrepresents the run that's already flying (its mode/permission/model were captured at launch).
    // (/model is allowed mid-run: the switch applies at the next step and the agent re-fits to the new model.)
    const CONFIG = new Set(["/effort", "/plan", "/build", "/ask", "/accept", "/bypass"]);
    if (busyRef.current && CONFIG.has(command.name)) {
      dispatch({
        t: "notice",
        level: "warn",
        text: "finish or cancel the current run first (esc) to change mode or effort",
      });
      setBuffer("");
      return;
    }
    switch (command.name) {
      case "/help":
        dispatch({
          t: "notice",
          level: "info",
          text: helpText(SLASH_COMMANDS, commandPalette.length),
        });
        break;
      case "/tools": {
        // Make the tool set VISIBLE so it's clear which tools are available. Built-ins are
        // always wired; MCP tools connect in the background; the subagent tool delegates. Plan mode offers
        // only the read-only ones.
        const mcp = deps.getMcpTools?.() ?? deps.mcpTools ?? [];
        const builtins = createBuiltinRegistry().list();
        // A tool is available in PLAN mode iff every effect is "read" (true for zero-effect tools like
        // ask_user) — matching the permission engine. Everything else is Build-only.
        const planSafe = (t: (typeof builtins)[number]) =>
          t.manifest.effects.every((e) => e === "read");
        const inPlan = builtins.filter(planSafe).map((t) => t.manifest.name);
        const buildOnly = builtins.filter((t) => !planSafe(t)).map((t) => t.manifest.name);
        dispatch({
          t: "notice",
          level: "info",
          text: `tools · ${builtins.length} built-in + subagent${mcp.length ? ` + ${mcp.length} MCP` : ""} (all offered in Build; only the Plan-safe ones in Plan)`,
        });
        dispatch({ t: "notice", level: "info", text: `Plan + Build: ${inPlan.join(" ")}` });
        dispatch({ t: "notice", level: "info", text: `Build only: ${buildOnly.join(" ")}` });
        if (mcp.length > 0) {
          dispatch({
            t: "notice",
            level: "info",
            text: `mcp: ${mcp.map((t) => t.manifest.name).join(" ")}`,
          });
        }
        break;
      }
      case "/model":
        if (arg) {
          chooseModel(arg.trim());
          setBuffer(""); // openModelPicker clears the else-branch; the arg branch must too
        } else {
          openModelPicker();
        }
        return;
      case "/models":
        openModelPicker();
        return;
      case "/effort":
        if (arg) {
          const n = normalizeEffortSetting(arg);
          if (n) {
            const e = n.setting;
            effortRef.current = e;
            dispatch({ t: "effort", effort: e });
            dispatch({
              t: "notice",
              level: "info",
              text: n.alias ? effortAliasNote(arg.trim(), e) : `effort → ${e}`,
            });
          } else {
            dispatch({
              t: "notice",
              level: "warn",
              text: `unknown effort: ${arg} — pick one of ${EFFORTS.join(" / ")}`,
            });
          }
          setBuffer(""); // openEffortPicker clears the else-branch; the arg branch must too
        } else {
          openEffortPicker();
        }
        return;
      case "/plan":
        agentModeRef.current = "plan";
        dispatch({ t: "agentMode", agentMode: "plan" });
        break;
      case "/build":
        agentModeRef.current = "build";
        dispatch({ t: "agentMode", agentMode: "build" });
        break;
      case "/ask":
      case "/accept":
      case "/bypass": {
        const p: Permission =
          command.name === "/accept"
            ? "accept-edits"
            : command.name === "/bypass"
              ? "bypass"
              : "ask";
        permissionRef.current = p;
        dispatch({ t: "permission", permission: p });
        break;
      }
      case "/thinking":
        dispatch({ t: "toggleThinking" });
        break;
      case "/compact": {
        if (busyRef.current) {
          dispatch({ t: "notice", level: "warn", text: "busy — /compact after the current run" });
          break;
        }
        void runCompact(arg);
        break;
      }
      case "/context": {
        const model = state.status.reportedModel ?? state.status.targetModel;
        const window = state.status.contextWindow;
        dispatch({
          t: "notice",
          level: "info",
          text: contextReport({
            ...(model ? { model: shortName(model) } : {}),
            ...(window
              ? { window, compactsAt: window - budgetsFor(window, UNKNOWN_OUTPUT).compactReserve }
              : {}),
            ...(state.status.promptEstimate !== undefined
              ? { inUse: state.status.promptEstimate }
              : {}),
            ...(state.status.usage ? { usage: state.status.usage } : {}),
          }),
        });
        break;
      }
      case "/usage":
        dispatch({ t: "notice", level: "info", text: usageReport(state.status.usage) });
        break;
      case "/hooks":
      case "/permissions":
      case "/trust": {
        const settings = deps.settings;
        const word = arg.trim().toLowerCase();
        // `/trust yes` trusts; plain `/trust` shows what would be trusted.
        const confirm = command.name === "/trust" && word === "yes";
        const text = !settings
          ? "No hooks, permission rules or project settings."
          : confirm
            ? settings.trust()
            : (command.name === "/hooks"
                ? settings.hooksSummary()
                : command.name === "/permissions"
                  ? settings.permissionsSummary()
                  : settings.trustSummary()
              ).join("\n");
        dispatch({ t: "notice", level: "info", text });
        break;
      }
      case "/memory": {
        const memory = deps.memory;
        if (!memory) {
          dispatch({ t: "notice", level: "info", text: "Memory isn't available here." });
          break;
        }
        const [sub = "", ...rest] = arg.trim().split(/\s+/);
        const text =
          sub === "forget"
            ? memory.forget(rest[0] ?? "")
            : sub === "all"
              ? memory.rememberEverywhere(rest.join(" "))
              : memory.report();
        dispatch({ t: "notice", level: "info", text });
        break;
      }
      case "/jobs": {
        const jobs = runStateRef.current.jobs;
        const [sub, id] = arg.trim().split(/\s+/);
        if (sub === "kill") {
          dispatch({
            t: "notice",
            level: "info",
            text:
              id && jobs.kill(id) ? `Stopped ${id}.` : `No running background command ${id ?? ""}.`,
          });
          break;
        }
        const list = jobs.list();
        dispatch({
          t: "notice",
          level: "info",
          text:
            list.length === 0
              ? "No background commands. The agent starts one with bash's background option (a dev server, a watcher)."
              : [
                  "Background commands:",
                  ...list.map(
                    (j) =>
                      `  ${j.id}  ${j.exitCode === undefined ? "running " : j.exitCode === null ? "stopped " : `exit ${j.exitCode}`.padEnd(8)}  ${j.command.slice(0, 70)}`,
                  ),
                  "/jobs kill <id> stops one.",
                ].join("\n"),
        });
        break;
      }
      case "/mcp": {
        const [sub, name] = arg.trim().split(/\s+/);
        if (!deps.mcp) {
          dispatch({
            t: "notice",
            level: "info",
            text: 'MCP is off for this session (--no-mcp, AMBIENT_NO_MCP or "noMcp" in config).',
          });
        } else if (sub === "login") {
          if (!name) {
            dispatch({ t: "notice", level: "info", text: "usage: /mcp login <server>" });
            break;
          }
          dispatch({
            t: "notice",
            level: "info",
            text: `Opening your browser to sign in to ${name}…`,
          });
          void deps.mcp
            .login(name, (url) =>
              dispatch({ t: "notice", level: "info", text: `If it didn't open, visit:\n${url}` }),
            )
            .then((text) => dispatch({ t: "notice", level: "info", text }));
        } else {
          dispatch({ t: "notice", level: "info", text: mcpReport(deps.mcp.status()) });
        }
        break;
      }
      case "/goal": {
        const a = arg.trim();
        // `/goal` (no arg) or `/goal show` → report the current goal into the transcript.
        if (!a || a.toLowerCase() === "show") {
          dispatch({
            t: "notice",
            level: "info",
            text: goalRef.current
              ? `goal: ${goalRef.current}`
              : "no goal set — `/goal <objective>` sets a north-star the agent keeps in view every turn",
          });
          break;
        }
        // `/goal clear` (and friends) → drop the north-star.
        if (["clear", "off", "reset", "none"].includes(a.toLowerCase())) {
          goalRef.current = "";
          dispatch({ t: "goal", text: "" });
          dispatch({ t: "notice", level: "info", text: "goal cleared" });
          break;
        }
        // Otherwise set/replace it (trimmed + length-capped by the reducer; mirror the capped value in the ref).
        const next = a.slice(0, MAX_GOAL_CHARS);
        goalRef.current = next;
        dispatch({ t: "goal", text: next });
        dispatch({ t: "notice", level: "info", text: `goal set — ${next}` });
        break;
      }
      case "/attach": {
        const path = arg.trim();
        if (!path) {
          dispatch({
            t: "notice",
            level: "info",
            text: "usage: /attach <path-to-image> (or Ctrl+V to paste)",
          });
        } else {
          void attachImageFile(path, "file").then((res) => {
            if (res.ok) addAttachment(res.attachment);
            else dispatch({ t: "notice", level: "warn", text: res.reason });
          });
        }
        break;
      }
      case "/skills": {
        // Open the interactive browser when we have the skill rows; else a summary notice.
        if (deps.skills && deps.skills.length > 0) {
          setSkillFilter("");
          setPickerSel(0);
          setPicker("skills");
        } else {
          const info = deps.skillsInfo;
          const count = info
            ? `${info.total} skill${info.total === 1 ? "" : "s"} available`
            : "Skills";
          const pin = info && info.pinned > 0 ? ` · ${info.pinned} pinned (always load)` : "";
          dispatch({
            t: "notice",
            level: "info",
            text: `${count}${pin} — searched on demand. Browse: ambient skills · pin: ambient skills pin "<name>"`,
          });
        }
        break;
      }
      case "/clear": {
        // Clearing the screen also starts a NEW conversation: drop the session refs so the next turn mints a
        // fresh id/writer and carries NO prior-turn context (otherwise the agent would "remember" what the
        // user just cleared). Only when idle — a mid-run /clear must not swap the session out from under it.
        const fresh = !busyRef.current;
        if (fresh) {
          sessionIdRef.current = null;
          writerRef.current = null;
          // Nothing from the cleared conversation carries into the next one: not its plan, not its effort.
          planRef.current = [];
          lastEffortRef.current = undefined;
          skipLogReplayRef.current = false;
          conversationRef.current = [];
          sessionImagesRef.current = [];
          runStateRef.current = newRunState();
          setJobsEpoch((n) => n + 1); // the old session's background commands stop with it
        }
        // The kept plan is now from a cleared session — retire the review prompt/gesture so an empty Enter can't
        // silently execute a stale plan in the fresh session.
        setPlanReview(false);
        dispatch({ t: "clear", fresh });
        // Scrollback printed by <Static> is outside React's control: clear the screen + scrollback and remount
        // <Static> (its internal cursor would otherwise skip the first items of the fresh transcript).
        stdout?.write("\x1b[2J\x1b[3J\x1b[H");
        committedRef.current = 0;
        setStaticEpoch((n) => n + 1);
        break;
      }
      case "/login":
        if (busyRef.current) {
          dispatch({ t: "notice", level: "warn", text: "busy — /login after the current run" });
        } else if (!deps.account) {
          dispatch({
            t: "notice",
            level: "warn",
            text: "Run `ambient login` in your shell to change keys.",
          });
        } else {
          keyFlow.open("change");
        }
        setBuffer("");
        break;
      case "/logout":
        if (deps.account) dispatch({ t: "notice", level: "info", text: deps.account.remove() });
        setBuffer("");
        break;
      case "/quit":
        // Never quit with work still flying — abort the run first so nothing runs on invisibly.
        if (busyRef.current) abortRun();
        exit();
        break;
      default: {
        // An MCP server's prompt → ask the server for its text, then run that as the task.
        const mcp = deps.mcp;
        if (command.name.startsWith("/mcp__") && mcp) {
          if (busyRef.current) {
            dispatch({
              t: "notice",
              level: "warn",
              text: `busy — wait for the current run before running ${command.name}`,
            });
            break;
          }
          setBuffer("");
          void mcp
            .expandPrompt(command.name, arg)
            .then((text) => runTaskRef.current?.(text))
            .catch((e: unknown) =>
              dispatch({ t: "notice", level: "warn", text: (e as Error).message }),
            );
          break;
        }
        // A discovered Claude/Codex command → expand its template with the args and run it as a task.
        const body = customCommands.bodies.get(command.name);
        if (body === undefined) {
          dispatch({ t: "notice", level: "warn", text: `unknown command: ${command.name}` });
        } else if (busyRef.current) {
          // runTask no-ops while a run is in flight — say so instead of silently dropping the command.
          dispatch({
            t: "notice",
            level: "warn",
            text: `busy — wait for the current run before running ${command.name}`,
          });
        } else {
          setBuffer("");
          // Read the command file again now: what runs must be what's on disk and trusted today, not the copy
          // loaded when the session started (a branch checkout can change it in between).
          const current =
            discoverCommands(deps.workspaceRoot).find((c) => `/${c.name}` === command.name) ?? body;
          void runTaskRef.current?.(
            expandSlashCommand(current, splitArgs(arg), {
              workspaceRoot: deps.workspaceRoot,
              home: homedir(),
              ...(deps.settings?.rules() ? { rules: deps.settings.rules() } : {}),
              projectTrusted: deps.settings?.projectTrusted() === true,
            }),
          );
        }
      }
    }
    setBuffer("");
  };

  /** Files matching the `@` mention being typed at `cursor` (empty when none, or it was closed with Esc). */
  const fileMatchesFor = (text: string, cur: number): string[] => {
    // The / menu and a recalled prompt own the keys; the picker only opens while composing.
    if (hist.browsing()) return [];
    if (text.startsWith("/") && matchSlash(text, commandPalette).length > 0) return [];
    const mention = activeMention(text, cur);
    if (!mention) {
      mentionClosedRef.current = undefined; // a new @ later opens the picker again
      return [];
    }
    if (mention.start === mentionClosedRef.current) return [];
    if (filesRef.current === undefined) {
      if (!filesLoadingRef.current && deps.listFiles) {
        filesLoadingRef.current = true;
        void deps
          .listFiles()
          .catch(() => [])
          .then((list) => {
            filesRef.current = list;
            setFiles(list);
          });
      }
      return [];
    }
    const cached = fileMatchCacheRef.current;
    if (cached && cached.query === mention.query && cached.files === filesRef.current) {
      return cached.matches;
    }
    const matches = (
      mention.query ? fuzzyRank(mention.query, filesRef.current, (f) => f) : filesRef.current
    ).slice(0, FILE_PICKER_ROWS);
    fileMatchCacheRef.current = { query: mention.query, files: filesRef.current, matches };
    return matches;
  };

  useInput((ch, key) => {
    // 0) The key panel owns the keyboard while open (Ctrl+C still quits).
    if (!(key.ctrl && ch === "c") && keyFlow.handleInput(ch, key)) return;
    // 1) A pending approval takes precedence. Two equal paths to the SAME four outcomes (resolveApprovalKey):
    //    move the ▸ cursor with ↑/↓ and confirm with Enter/Space, OR press the y/a/b/n hotkey to jump-and-confirm.
    if (approvalResolver.current) {
      const r = resolveApprovalKey(
        ch,
        key,
        approvalSelRef.current,
        Date.now() - approvalShownAtRef.current,
      );
      if (r.t === "abort")
        abortRun(); // abort the whole run, not merely deny (global cancel contract)
      else if (r.t === "move") setApprovalSel(r.sel);
      else if (r.t === "confirm") finishApproval(r.decision);
      return;
    }

    // 1.5) An open questionnaire (ask_user) owns the keyboard: ↑/↓ move the option cursor, Tab toggles a
    //      choice (multi-select), typing fills the note, Enter submits, Esc skips (agent proceeds on its own).
    //      Ctrl+C still aborts the whole run.
    if (questionRef.current) {
      const q = questionRef.current;
      const opts = q.req.options ?? [];
      if (key.ctrl && ch === "c") {
        abortRun();
        return;
      }
      if (key.escape) {
        finishQuestion({ selected: [], cancelled: true });
        return;
      }
      if (key.return) {
        submitQuestion();
        return;
      }
      if (opts.length > 0 && (key.upArrow || key.downArrow)) {
        const next = key.upArrow
          ? Math.max(0, q.cursor - 1)
          : Math.min(opts.length - 1, q.cursor + 1);
        setQuestionState({ ...q, cursor: next });
        return;
      }
      if (opts.length > 0 && q.req.multiSelect === true && key.tab) {
        const selected = new Set(q.selected);
        if (selected.has(q.cursor)) selected.delete(q.cursor);
        else selected.add(q.cursor);
        setQuestionState({ ...q, selected });
        return;
      }
      if (q.req.allowText !== false) {
        if (key.backspace || key.delete) {
          setQuestionState({ ...q, text: q.text.slice(0, -1) });
          return;
        }
        // Printable text → append to the note: a keystroke OR a paste (a multi-char chunk). Control keys /
        // arrows / tab arrive as "" or control characters and are ignored; pasted newlines become spaces.
        if (ch.length > 0 && !key.ctrl && !key.meta && !isAllControl(ch)) {
          setQuestionState({
            ...q,
            text: q.text + normalizePastedText(ch).replace(/\s*\n\s*/g, " "),
          });
          return;
        }
      }
      return; // swallow everything else while the question is open
    }

    // 2) Ctrl+C always cancels a run in flight, else quits.
    if (key.ctrl && ch === "c") {
      if (busyRef.current) abortRun();
      else exit();
      return;
    }

    // 2b) Ctrl+R searches previous prompts; while searching, the search line owns the keyboard.
    if (hist.searching()) {
      if (key.escape) setBuffer(hist.searchCancel());
      else if (key.return) setBuffer(hist.searchAccept());
      else if (key.ctrl && ch === "r") hist.searchOlder();
      else if (key.backspace || key.delete) hist.searchBackspace();
      else if (ch && !key.ctrl && !key.meta && !isAllControl(ch)) {
        hist.searchType(normalizePastedText(ch).replace(/\s*\n\s*/g, " "));
      }
      return;
    }
    if (key.ctrl && ch === "r" && pickerRef.current === null) {
      hist.startSearch(inputRef.current);
      return;
    }

    // 2c) The `@` file picker owns ↑/↓/Tab/Enter/Esc while it's showing.
    const fileMatches = fileMatchesFor(inputRef.current, cursorRef.current);
    if (fileMatches.length > 0 && pickerRef.current === null) {
      const mention = activeMention(inputRef.current, cursorRef.current);
      if (key.escape && mention) {
        mentionClosedRef.current = mention.start;
        setMentionClosedAt(mention.start);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const next = key.upArrow
          ? Math.max(0, fileSelRef.current - 1)
          : Math.min(fileMatches.length - 1, fileSelRef.current + 1);
        fileSelRef.current = next;
        setFileSel(next);
        return;
      }
      if ((key.tab || key.return) && mention) {
        const chosen = fileMatches[Math.min(fileSelRef.current, fileMatches.length - 1)] as string;
        const r = insertMention(inputRef.current, cursorRef.current, mention, chosen);
        setBuffer(r.text, r.cursor);
        fileSelRef.current = 0;
        setFileSel(0);
        return;
      }
    }

    // Ctrl+T toggles the live model-reasoning view anytime (view-only; safe mid-run).
    if (key.ctrl && ch === "t") {
      dispatch({ t: "toggleThinking" });
      return;
    }

    // Expand/collapse the LIVE subagent wave so you can SEE what the children are doing (the user's ask):
    // Ctrl+O toggles anytime; ↓ expands / ↑ collapses when no overlay owns the arrows. View-only, safe mid-run.
    const hasRunningSubagent = state.wave !== undefined;
    if (hasRunningSubagent && key.ctrl && ch === "o") {
      setSubagentExpanded((v) => !v);
      return;
    }
    // Use the REFS (not the possibly-stale useState values) for overlay precedence — parity with the
    // approval/question/picker handlers below, so a just-opened overlay can never lose an arrow to this.
    const arrowsFree =
      !approvalResolver.current &&
      !questionRef.current &&
      pickerRef.current === null &&
      // The slash menu owns the arrows only while it's showing (a recalled "/Users/…" prompt has no menu).
      (!inputRef.current.startsWith("/") ||
        hist.browsing() ||
        matchSlash(inputRef.current, commandPalette).length === 0);
    // Composer caret motion. Left/Right/Home/End always move the caret; Up/Down move it only when the buffer
    // spans multiple visual rows — otherwise they fall through to the subagent-expand shortcut below (so
    // watching a wave keeps ↑/↓ = expand/collapse; Ctrl+O toggles it regardless). Precedence:
    // overlays > multi-row caret > subagent ↑/↓.
    if (arrowsFree && !key.ctrl && !key.meta) {
      const w = composerTextWidth(width);
      if (key.leftArrow) {
        setBuffer(inputRef.current, moveLeft(inputRef.current, cursorRef.current));
        goalColRef.current = undefined;
        return;
      }
      if (key.rightArrow) {
        setBuffer(inputRef.current, moveRight(inputRef.current, cursorRef.current));
        goalColRef.current = undefined;
        return;
      }
      if (key.home) {
        setBuffer(inputRef.current, moveHome(inputRef.current, cursorRef.current, w));
        goalColRef.current = undefined;
        return;
      }
      if (key.end) {
        setBuffer(inputRef.current, moveEnd(inputRef.current, cursorRef.current, w));
        goalColRef.current = undefined;
        return;
      }
      if ((key.upArrow || key.downArrow) && layoutRows(inputRef.current, w).length > 1) {
        if (goalColRef.current === undefined) {
          goalColRef.current = cursorGoalCol(inputRef.current, cursorRef.current, w);
        }
        const next = key.upArrow
          ? moveUp(inputRef.current, cursorRef.current, w, goalColRef.current)
          : moveDown(inputRef.current, cursorRef.current, w, goalColRef.current);
        // Already at the very start (↑) or end (↓): the key moves on to prompt history instead.
        if (next !== cursorRef.current) {
          setBuffer(inputRef.current, next);
          return;
        }
      }
    }
    if (hasRunningSubagent && arrowsFree && !hist.browsing() && (key.downArrow || key.upArrow)) {
      setSubagentExpanded(key.downArrow === true);
      return;
    }
    // ↑/↓ on the composer recall previous prompts (↓ past the newest gives back the unsent draft).
    if (arrowsFree && !key.ctrl && !key.meta && (key.upArrow || key.downArrow)) {
      const text = key.upArrow ? hist.older(inputRef.current) : hist.newer();
      if (text !== undefined) {
        setBuffer(text);
        goalColRef.current = undefined;
      }
      return;
    }

    // Readline-style editing in the composer: Ctrl+A/E line start/end, Ctrl+U/K cut to start/end of the
    // line, Ctrl+W delete the previous word, Alt+B/F move by word. Pickers keep their own keys.
    if (pickerRef.current === null && (key.ctrl || key.meta)) {
      const text = inputRef.current;
      const cur = cursorRef.current;
      const edit = (r: { text: string; cursor: number }) => {
        setBuffer(r.text, r.cursor);
        goalColRef.current = undefined;
        hist.stopBrowsing();
      };
      const move = (to: number) => {
        setBuffer(text, to);
        goalColRef.current = undefined;
      };
      if (key.ctrl && ch === "a") return move(lineStart(text, cur));
      if (key.ctrl && ch === "e") return move(lineEnd(text, cur));
      if (key.ctrl && ch === "u") return edit(deleteToLineStart(text, cur));
      if (key.ctrl && ch === "k") return edit(deleteToLineEnd(text, cur));
      if (key.ctrl && ch === "w") return edit(deleteWordBack(text, cur));
      if (key.meta && ch === "b") return move(wordLeft(text, cur));
      if (key.meta && ch === "f") return move(wordRight(text, cur));
    }

    // Ctrl+V pastes an image from the clipboard (macOS) — attach it to the next message.
    if (key.ctrl && ch === "v") {
      void captureImage();
      return;
    }

    // 3) The model picker owns ↑/↓/Enter/Esc while open.
    if (pickerRef.current === "model") {
      const list = pickerFleet;
      if (key.escape) {
        setPicker(null);
        return;
      }
      if (key.upArrow) {
        setPickerSel(Math.max(0, pickerSelRef.current - 1));
        return;
      }
      if (key.downArrow) {
        setPickerSel(Math.min(Math.max(0, list.length - 1), pickerSelRef.current + 1));
        return;
      }
      if (key.return) {
        const row = list[pickerSelRef.current];
        if (row) chooseModel(row.id);
        setPicker(null);
        return;
      }
      return; // swallow other keys while picking
    }

    // 3b) The effort picker owns ↑/↓/Enter/Esc while open.
    if (pickerRef.current === "effort") {
      if (key.escape) {
        setPicker(null);
        return;
      }
      if (key.upArrow) {
        setPickerSel(Math.max(0, pickerSelRef.current - 1));
        return;
      }
      if (key.downArrow) {
        setPickerSel(Math.min(EFFORTS.length - 1, pickerSelRef.current + 1));
        return;
      }
      if (key.return) {
        const e = EFFORTS[pickerSelRef.current];
        if (e) {
          effortRef.current = e;
          dispatch({ t: "effort", effort: e });
          dispatch({ t: "notice", level: "info", text: `effort → ${e}` });
        }
        setPicker(null);
        return;
      }
      return; // swallow other keys while picking
    }

    // 3c) The skills browser owns typing (filter) / ↑↓ / Tab (pin) / Enter (use) / Esc while open.
    if (pickerRef.current === "skills") {
      const list = filteredSkillsRef.current;
      if (key.escape) {
        setPicker(null);
        setSkillFilter("");
        return;
      }
      if (key.upArrow) {
        setPickerSel(Math.max(0, pickerSelRef.current - 1));
        return;
      }
      if (key.downArrow) {
        setPickerSel(Math.min(Math.max(0, list.length - 1), pickerSelRef.current + 1));
        return;
      }
      if (key.tab) {
        const row = list[pickerSelRef.current];
        if (row && deps.onTogglePin) {
          const nowPinned = deps.onTogglePin(row.name);
          setPinnedSet((prev) => {
            const next = new Set(prev);
            if (nowPinned) next.add(row.name);
            else next.delete(row.name);
            return next;
          });
        }
        return;
      }
      if (key.return) {
        const row = list[pickerSelRef.current];
        setPicker(null);
        setSkillFilter("");
        if (row) setBuffer(`use the ${row.name} skill to `); // hand it to the composer to finish + run
        return;
      }
      if (key.backspace || key.delete) {
        setSkillFilter(skillFilterRef.current.slice(0, -1));
        setPickerSel(0);
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        setSkillFilter(skillFilterRef.current + ch);
        setPickerSel(0);
        return;
      }
      return; // swallow other keys while browsing
    }

    // 4) Slash-command palette.
    const slashMatches = matchSlash(inputRef.current, commandPalette);
    if (inputRef.current.startsWith("/") && slashMatches.length > 0) {
      if (key.escape) {
        // Esc closes the menu only. Dismissing a menu must never kill a run in flight (a second Esc does).
        setBuffer("");
        return;
      }
      if (key.upArrow) {
        setSlashSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSel((s) => Math.min(slashMatches.length - 1, s + 1));
        return;
      }
      if (key.return || (key.tab && !key.shift)) {
        const idx = Math.min(slashSel, slashMatches.length - 1);
        const command = slashMatches[idx] as SlashCommand;
        const arg = inputRef.current.replace(/^\/\S*\s*/, "").trim();
        runSlash(command, arg);
        return;
      }
    }

    // 5) Esc cancels a run.
    if (key.escape) {
      if (busyRef.current) abortRun();
      return;
    }

    // 6) Tab toggles PLAN ↔ BUILD; Shift+Tab cycles the PERMISSION — not mid-run (the run captured both).
    if (key.tab && !key.shift) {
      if (busyRef.current) return;
      const m = toggleAgentMode(agentModeRef.current);
      agentModeRef.current = m;
      dispatch({ t: "agentMode", agentMode: m });
      return;
    }
    if (key.tab && key.shift) {
      if (busyRef.current) return;
      const p = nextPermission(permissionRef.current);
      permissionRef.current = p;
      dispatch({ t: "permission", permission: p });
      return;
    }

    // 7) Enter runs (idle) or QUEUES (in flight). A line ending in `\` continues onto a new line instead
    //    (works in every terminal, unlike Shift+Enter).
    if (
      key.return &&
      inputRef.current.endsWith("\\") &&
      cursorRef.current === inputRef.current.length
    ) {
      setBuffer(`${inputRef.current.slice(0, -1)}\n`);
      return;
    }
    if (key.return) {
      const task = inputRef.current.trim();
      // A slash-prefixed input that matched no command is a typo (e.g. `/modle`) — report it, don't
      // silently run it as a (paid) agent task.
      if (looksLikeSlashCommand(task)) {
        dispatch({ t: "notice", level: "warn", text: `unknown command: ${task.split(/\s/)[0]}` });
        setBuffer("");
        return;
      }
      // `# note` (one line) is a quick note for this project's memory — saved directly, no model call.
      const note = quickNote(task);
      if (note !== undefined) {
        dispatch({
          t: "notice",
          level: "info",
          text: deps.memory ? deps.memory.remember(note) : "Memory isn't available here.",
        });
        hist.record(task);
        setBuffer("");
        return;
      }
      // In BUILD mode with a saved plan, Enter on an empty line executes the plan.
      const canRunPlan =
        !task &&
        agentModeRef.current === "build" &&
        planRef.current.some((t) => t.status !== "done");
      // In PLAN mode with a ready plan, Enter on an empty line APPROVES it → flip to Build + execute (the
      // approve half of the plan-review prompt; typing instead sends a revision that the agent edits into).
      const canApprovePlan =
        !task &&
        attachmentsRef.current.length === 0 && // an image-only send is NOT an approval — it revises with the image
        planReviewPendingRef.current && // only a FRESH plan (not a build-leftover, or one kept across /clear)
        agentModeRef.current === "plan" &&
        planRef.current.some((t) => t.status !== "done");
      const hasAttach = attachmentsRef.current.length > 0;
      // Enter on an empty line while your messages wait on a subagent wave: ask it to wrap up and report now,
      // so the agent reads them sooner.
      if (!task && !hasAttach && busyRef.current && steerRef.current.length > 0 && state.wave) {
        if (!hurryRef.current) {
          hurryRef.current = true;
          dispatch({
            t: "notice",
            level: "info",
            text: "Asking the subagents to wrap up and report, so the agent can read your message.",
          });
        }
        return;
      }
      // Allow an image-only send (attachment + no text) — a common "look at this" flow.
      if (!task && !canRunPlan && !canApprovePlan && !hasAttach) return;
      const attach = attachmentsRef.current;
      if (task && !(busyRef.current && cancellingRef.current)) hist.record(task);
      if (busyRef.current) {
        if (cancellingRef.current) return;
        if (!task && !hasAttach) return;
        // Text-only → STEER the running agent (injected at its next turn boundary). With an attachment →
        // queue a follow-up RUN (images need the full run setup and can't be injected mid-conversation).
        if (task && !hasAttach) {
          steerRef.current = [...steerRef.current, task];
        } else {
          queueRef.current = [...queueRef.current, { text: task, attachments: attach }];
        }
        setQueued([...steerRef.current, ...queueRef.current.map((q) => q.text)]);
        setAttachments([]);
        setBuffer("");
      } else {
        // Approve → switch to Build so the empty-Enter run executes the plan (withPlan needs build mode).
        if (canApprovePlan) {
          agentModeRef.current = "build";
          dispatch({ t: "agentMode", agentMode: "build" });
        }
        setBuffer("");
        setAttachments([]);
        void runTask(task, attach);
      }
      return;
    }
    if (key.backspace || key.delete) {
      // On an empty composer, Backspace removes the most recent image chip (nothing to delete otherwise).
      if (inputRef.current.length === 0 && attachmentsRef.current.length > 0) {
        setAttachments(attachmentsRef.current.slice(0, -1));
        return;
      }
      // Backspace deletes before the caret; Fn+Delete (key.delete) deletes the char AT the caret.
      const r = key.delete
        ? deleteForwardAt(inputRef.current, cursorRef.current)
        : deleteBackAt(inputRef.current, cursorRef.current);
      setBuffer(r.text, r.cursor);
      goalColRef.current = undefined;
      hist.stopBrowsing();
      return;
    }
    // A MULTI-char burst (a paste / drag-drop). Normalize it FIRST — strip bracketed-paste markers + stray
    // control bytes and normalize newlines — so markers never leak into the buffer and a dropped path is
    // still recognized once its wrapping markers are gone.
    const burst = ch && ch.length > 1 ? normalizePastedText(ch) : ch;
    // A single-line image PATH attaches the file instead of typing it; on a failed read, fall back to text.
    if (burst && burst.length > 1 && !key.ctrl && !key.meta && looksLikeImagePath(burst)) {
      void attachImageFile(burst, "drag").then((res) => {
        if (res.ok) addAttachment(res.attachment);
        else {
          dispatch({ t: "notice", level: "info", text: res.reason });
          const ins = insertAt(inputRef.current, cursorRef.current, burst); // don't drop the pasted text
          setBuffer(ins.text, ins.cursor);
        }
      });
      return;
    }
    if (burst && !key.ctrl && !key.meta) {
      // Insert typed chars / a paste AT the caret (not always the end), then advance the caret past it.
      const ins = insertAt(inputRef.current, cursorRef.current, burst);
      setBuffer(ins.text, ins.cursor);
      goalColRef.current = undefined;
      hist.stopBrowsing();
      fileSelRef.current = 0; // a changed @ query starts at its best match
      setFileSel(0);
    }
  });

  function finishApproval(decision: ApprovalDecision): void {
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    setPending(null);
    if (decision === "bypass") {
      // Flip the whole session to bypass (same as /bypass): future runs skip prompts, and `approve` short-
      // circuits the current run's remaining asks. The current request itself is let through as allow-once.
      permissionRef.current = "bypass";
      dispatch({ t: "permission", permission: "bypass" });
      dispatch({ t: "notice", level: "info", text: "Bypassing approvals for this session" });
      resolve?.("allow-once");
      return;
    }
    resolve?.(decision);
  }

  // A picker/overlay (model · effort · skills) replaces the splash banner so an overlay opened on a fresh
  // screen gets the full window height — otherwise the banner eats ~9 rows and the overlay overflows.
  // The splash stays until the conversation starts; notices from launch (a key note, an update) sit under it.
  // Only a few short launch notes may sit under the banner; a real exchange, or longer output such as /help,
  // ends the splash.
  const conversationStarted =
    state.transcript.some((t) => t.kind !== "notice" && t.kind !== "receipt") ||
    state.transcript.reduce((n, t) => n + ("text" in t ? t.text.split("\n").length : 1), 0) >
      SPLASH_NOTE_LINES;
  const slashMatches = matchSlash(input, commandPalette);
  const showSlash = input.startsWith("/") && slashMatches.length > 0 && !pending && picker === null;
  const fileMatches = picker === null && !pending ? fileMatchesFor(input, cursor) : [];
  const showFiles = !showSlash && fileMatches.length > 0;
  // The banner steps aside for any menu, so the menu gets the room (a squeezed menu overlaps its own rows).
  const onSplash = !conversationStarted && picker === null && !showSlash && !showFiles;
  const elapsed = runActive && runStartRef.current ? (Date.now() - runStartRef.current) / 1000 : 0;
  // Per-PHASE clock: reset whenever the current activity verb changes, so "Thinking · 0:12" means
  // thinking FOR 0:12, not 0:12 into the whole run.
  const phaseElapsed =
    runActive && phaseStartRef.current ? (Date.now() - phaseStartRef.current) / 1000 : 0;
  const readyCount = fleet ? fleet.filter((r) => r.avail === "ready").length : undefined;
  // Split the transcript into a SETTLED prefix (committed ONCE to terminal scrollback via <Static>) and the
  // LIVE tail (re-rendered until it settles). Splitting at the FIRST unsettled item keeps <Static> strictly
  // append-only even when parallel tools settle out of order — Static must never see an item re-ordered.
  const firstLive = state.transcript.findIndex((it) => !isSettled(it));
  const settledCount = firstLive < 0 ? state.transcript.length : firstLive;
  // On the splash, launch notes render live under the banner and commit with the rest once the conversation
  // starts. What was already committed (a menu hid the banner for a moment) stays committed — <Static> must
  // only ever grow, or it prints those items a second time.
  // Launch notes stay live while a menu is open too: committing them then would print them ABOVE the banner
  // that comes back when the menu closes.
  const commitCount = !conversationStarted
    ? Math.min(committedRef.current, settledCount)
    : settledCount;
  // The full banner only when it fits with the launch notes and the composer; otherwise the one-line lockup,
  // so nothing on the first screen gets cut off.
  // Rows a notice takes: a blank line above, then its text word-wrapped beside the 2-column "· " mark.
  const noticeRows = (text: string) =>
    1 +
    text
      .split("\n")
      .reduce((r, l) => r + Math.max(1, Math.ceil(l.length / Math.max(10, width - 5))), 0);
  const splashNoteRows = onSplash
    ? state.transcript.reduce((n, t) => n + ("text" in t ? noticeRows(t.text) : 2), 0)
    : 0;
  const updateRows = deps.update
    ? Math.ceil(
        `▲ ${deps.update.latest} available — ${deps.update.command}`.length /
          Math.max(10, width - 2),
      )
    : 0;
  const bannerShort =
    FULL_BANNER_ROWS +
      updateRows +
      splashNoteRows +
      (state.goal ? 1 : 0) +
      (attachments.length > 0 ? 1 : 0) +
      COMPOSER_ROWS >
    rows - 1;
  committedRef.current = Math.max(committedRef.current, commitCount);
  const settledItems = state.transcript.slice(0, commitCount);
  const liveItems = state.transcript.slice(commitCount);
  const interior = Math.max(1, width - 2);
  // Visible queue rows — a rows-derived budget so the always-on panel stack stays under the screen height.
  const qMax = Math.min(5, Math.max(1, rows - 20));
  // PLAN mode, idle, with a FRESH plan the run just produced → WAITING for the user. `planReviewPending` gates
  // out a stale plan (a build run that hit maxTurns, or a plan kept across /clear), so the prominent
  // approve/revise banner shows only when it truly means "done, your move".
  const planAwaitingReview =
    !runActive &&
    planReviewPending &&
    state.status.agentMode === "plan" &&
    state.plan.some((t) => t.status !== "done");
  // The composer EXPANDS into free vertical space when nothing else competes for it (a fresh screen / idle
  // compose) — so a big paste grows like a normal terminal input instead of collapsing to a chip. It stays at
  // the floor while a run is active or panels are up, so the live region never reaches `rows` (the strobe).
  const composerCanGrow =
    !runActive &&
    !planAwaitingReview &&
    !showSlash &&
    !showFiles &&
    picker === null &&
    queued.length === 0 &&
    state.plan.length === 0;
  const composerReserve =
    (onSplash ? (bannerShort ? 5 : FULL_BANNER_ROWS) : 0) + // the splash banner (idle home only)
    (state.goal ? 1 : 0) + // the pinned goal line
    (attachments.length > 0 ? 1 : 0) + // the attachment chip
    9; // status + hint + border + margins + a safety cushion so the whole stack stays under `rows`
  const composerMaxRows = composerCanGrow ? Math.max(6, rows - composerReserve) : 6;
  // Keep the STREAMING preview a SHORT, CONSTANT tail (not one screenful). A tall streaming frame that then
  // collapses when it settles into <Static> is what makes the layout "jump" (anchor flips bottom→top) and
  // leaves a blank band (log-update can't cursor-up over a viewport the tall frame scrolled). A small fixed
  // window keeps the live frame height stable, so completed answers flow top-down into scrollback without the
  // frame ever growing tall. Nothing is lost — the full answer commits to <Static> the instant it finalizes;
  // and once incremental-commit lands (assistant.delta), only the in-progress paragraph is ever live.
  const STREAM_TAIL_ROWS = 8;
  const maxStreamLines = STREAM_TAIL_ROWS;
  // Seconds since the live wave began — from a ref stamped when the wave id first appears (keeps `reduce` pure).
  const waveElapsed =
    state.wave && waveStartRef.current ? (Date.now() - waveStartRef.current) / 1000 : 0;

  return (
    // Ink 7 STILL writes CSI 2J+3J (which erases native scrollback) whenever the dynamic (non-<Static>) frame
    // OVERFLOWS the viewport — its synchronized-output only makes that atomic, it does NOT stop the erase. So
    // the invariant "the dynamic frame never exceeds `rows`" is enforced STRUCTURALLY, not by arithmetic: the
    // whole dynamic tree lives inside a `maxHeight={rows-1}` + `overflowY:"hidden"` clamp, so Ink measures its
    // height as the clamped value and the CSI-3J gate (nextOutputHeight > viewportRows) can never trip. Inside
    // the clamp: a flex-shrink, bottom-anchored scroll region holds the growable content (live transcript +
    // panels) and clips its OWN top when tall (keeping the most-recent tail); the footer (composer/modal +
    // status) is flexShrink=0 so it is NEVER clipped. When content is short the clamp shrinks to it, so the
    // composer still sits right under the answer (no gap). Settled turns commit to <Static> (real terminal
    // scrollback, NOT counted in the dynamic height) so they STAY visible where printed — scroll up to see them.
    <Box flexDirection="column" width={width} paddingX={1}>
      {/* SETTLED turns print ONCE into the terminal's REAL scrollback via <Static> — scroll up (trackpad/
          wheel) to see history. Never re-rendered, so each turn commits cleanly instead of repainting. */}
      <Static key={staticEpoch} items={settledItems}>
        {(item) => <TranscriptRow key={item.id} item={item} width={interior} settled />}
      </Static>

      {/* THE CLAMP — bounds the entire dynamic frame to rows-1 so Ink never full-clears (erasing scrollback). */}
      <Box flexDirection="column" maxHeight={Math.max(4, rows - 1)} overflowY="hidden">
        {/* Growable, bottom-anchored: live transcript + panels. Clips its TOP when it can't all fit, so the
            most-recent output (and the panels below it) stay visible while old streamed lines scroll off. */}
        <Box flexDirection="column" flexShrink={1} overflowY="hidden" justifyContent="flex-end">
          {/* Idle home: the brand banner (scrolls into history once the conversation starts). */}
          {onSplash ? (
            <Banner
              width={width}
              short={bannerShort}
              fleet={
                readyCount !== undefined
                  ? { ready: readyCount, total: fleet?.length ?? 0 }
                  : undefined
              }
              version={deps.version}
              {...(deps.update ? { update: deps.update } : {})}
            />
          ) : null}

          {/* The LIVE tail — the current turn's in-flight items (streamed preview perf-capped in TranscriptRow). */}
          {liveItems.length > 0 ? (
            <Transcript items={liveItems} width={interior} maxStreamLines={maxStreamLines} />
          ) : null}

          {/* Middle panels: goal, plan, live reasoning, the activity flightline, the queue, and any open picker. */}
          <Box flexDirection="column">
            <Goal goal={state.goal} plan={state.plan} running={state.status.running} />
            {/* Cap the plan SMALL (windowed around the active step) so the live region can't approach the terminal
            height — which would make Ink full-clear every frame (the "strobe" + it erases native scrollback). */}
            <Plan tasks={state.plan} max={Math.min(9, Math.max(3, rows - 14))} />
            <Thinking
              text={state.thinking}
              show={state.showThinking}
              width={width}
              maxLines={Math.min(6, Math.max(1, rows - 18))}
            />
            <ActivityLine
              // While you're being asked something, that's what's happening — not "Thinking" on a running clock.
              activity={pending || question ? undefined : state.status.activity}
              elapsed={elapsed}
              phaseElapsed={phaseElapsed}
              frame={tick}
              width={width}
              effort={state.status.resolvedEffort}
              stream={state.status.stream}
            />
            {/* The LIVE subagent wave — a small, fixed-height panel (never a tall re-rendering tree), so the
                dynamic frame stays under the viewport and can't scroll-strand/strobe. Each scout's result is a
                settled `subagent-line` in scrollback — scroll up to read it. */}
            {state.wave ? (
              <WaveSummary
                wave={state.wave}
                frame={tick}
                elapsed={waveElapsed}
                expanded={subagentExpanded}
                width={interior}
              />
            ) : null}
            {/* The queue/steer panel — labelled + count so the queue is always visible. Its visible
            rows are capped to a rows-budget (qMax) so the always-on stack can't grow past the screen. */}
            {queued.length > 0 ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={AmbientTheme.signal}>
                  {state.wave
                    ? `↳ ${queued.length} queued — the agent reads ${queued.length === 1 ? "it" : "them"} when the subagents report · enter: ask them to wrap up now`
                    : `↳ ${queued.length} queued — the agent picks ${queued.length === 1 ? "it" : "them"} up next`}
                </Text>
                {queued.slice(0, qMax).map((q, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: queue order is stable within a render
                  <Text key={i} color={AmbientTheme.dim} wrap="truncate-end">{`   • ${q}`}</Text>
                ))}
                {queued.length > qMax ? (
                  <Text color={AmbientTheme.dim}>{`   • … ${queued.length - qMax} more`}</Text>
                ) : null}
              </Box>
            ) : null}
            {picker === "model" ? (
              <Box marginTop={1}>
                <ModelPicker
                  rows={pickerFleet}
                  selected={pickerSel}
                  current={state.status.requestedModel}
                  width={width}
                />
              </Box>
            ) : null}
            {picker === "effort" ? (
              <Box marginTop={1}>
                <EffortPicker
                  efforts={EFFORTS}
                  selected={pickerSel}
                  current={state.status.effort}
                  width={width}
                />
              </Box>
            ) : null}
            {picker === "skills" ? (
              <Box marginTop={1}>
                <SkillsBrowser
                  rows={filteredSkills}
                  selected={Math.min(pickerSel, Math.max(0, filteredSkills.length - 1))}
                  filter={skillFilter}
                  total={deps.skills?.length ?? 0}
                  width={width}
                  maxRows={Math.max(3, rows - 11)}
                />
              </Box>
            ) : null}
            {showSlash ? (
              <Box marginTop={1}>
                <SlashPalette
                  commands={slashMatches}
                  selected={Math.min(slashSel, slashMatches.length - 1)}
                  width={width}
                />
              </Box>
            ) : null}
            {showFiles ? (
              <Box marginTop={1} flexShrink={0}>
                <FilePicker
                  files={fileMatches}
                  selected={Math.min(fileSel, fileMatches.length - 1)}
                  width={width}
                />
              </Box>
            ) : null}
          </Box>
        </Box>

        {/* FOOTER — composer/modal + status. flexShrink=0 so the clamp never clips the user's input. */}
        <Box flexDirection="column" flexShrink={0}>
          <Box marginTop={1} flexShrink={0}>
            {keyFlow.state ? (
              <KeyPrompt
                state={keyFlow.state}
                width={width}
                keysUrl={deps.account?.keysUrl ?? ""}
              />
            ) : question ? (
              // A pending questionnaire replaces the composer (like the Approval modal) — it owns the keyboard.
              <Question state={question} width={width} />
            ) : pending ? (
              // Cap the preview so the header + all four choices + borders + status stay on-screen on a short
              // terminal (the choices must never scroll off). 21 rows are the modal's fixed furniture
              // in the WORST case (risk callout + overflow marker + StatusLine); the preview yields to 0 first, so
              // at rows=24 → 3 preview lines and 21+3 = 24 exactly.
              <Approval
                req={pending}
                width={width}
                selected={approvalSel}
                maxPreview={Math.max(0, Math.min(14, rows - 21))}
              />
            ) : (
              // The composer IS the single plan-review surface (one clear prompt, no second overlapping
              // banner): in plan-review it shows a "PLAN READY" header + a signal border; Enter approves.
              <Box flexDirection="column">
                {hist.search ? <HistorySearch search={hist.search} width={width} /> : null}
                <Composer
                  value={input}
                  cursor={cursor}
                  running={runActive}
                  width={width}
                  agentMode={state.status.agentMode}
                  maxRows={composerMaxRows}
                  attachments={attachments}
                  visionNote={
                    attachments.length > 0
                      ? visionNote(state.status.requestedModel, fleet)
                      : undefined
                  }
                  planReview={planAwaitingReview}
                  planReviewSteps={state.plan.filter((t) => t.status !== "done").length}
                  planReady={
                    !runActive &&
                    state.status.agentMode === "build" &&
                    state.plan.some((t) => t.status !== "done")
                  }
                />
              </Box>
            )}
          </Box>
          <Box flexShrink={0}>
            <StatusLine
              status={state.status}
              width={width}
              active={runActive}
              showThinking={state.showThinking}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Whether submitted text is meant as a slash command. A prompt that merely starts with a path
 * ("/Users/me/app.ts is broken") is a task, not an unknown command: a command name has no further slash.
 */
export function looksLikeSlashCommand(
  text: string,
  pathExists: (p: string) => boolean = existsSync,
): boolean {
  const first = text.trim().split(/\s/)[0] ?? "";
  if (!/^\/[A-Za-z][\w:.-]*$/.test(first)) return false;
  // "/tmp is full" or "/README.md is wrong": a real path on disk is a task about that path, not a command.
  return !pathExists(first);
}

/** True when every character is a control character (C0 or DEL) — a keypress with nothing printable. */
function isAllControl(text: string): boolean {
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) return false;
  }
  return true;
}

/** Sent when a run that already did work died on a rejected key and a working key is now saved. */
const CONTINUE_AFTER_KEY =
  "Continue the task from where you stopped — the previous attempt was interrupted when Ambient rejected the API key. Don't redo steps that already completed.";
