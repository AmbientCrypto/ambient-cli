import { type PermissionRules, capMode } from "@amb/permissions";
import { type Mode, type NewEvent, newSessionId } from "@amb/protocol";
import type { RoutedRole } from "@amb/reliability";
import type { ToolRegistry } from "@amb/tools-core";
import { capToolResult } from "./agent-support.js";
import { Agent } from "./agent.js";
import type {
  Approver,
  AskPort,
  CapabilityPort,
  ChatClient,
  EffortSetting,
  HooksPort,
  RunOptions,
  VerifyPort,
  WorkspaceContextPort,
} from "./ports.js";

export type SubagentRole = "scout" | "oracle" | "builder";

export interface SubagentSpec {
  label: string;
  role: SubagentRole;
  prompt: string;
  preset?: string;
  model?: string;
  /** Ambient tool names a resolved preset restricts this child to (∩ the role's read/write constraint).
   *  Undefined ⇒ the role default (all read-only for scout/oracle, all builtins for builder). */
  allowedTools?: string[];
  /** A preset's own prompt — the child's system-level instructions (the task stays in `prompt`). */
  instructions?: string;
  /** Orchestrator-requested turn budget for THIS child, bounded by MAX_TURNS_CEILING. Undefined ⇒ the role
   *  default. Lets the parent grant a big-package scout more turns instead of fanning out a second wave. */
  maxTurns?: number;
}

export interface SubagentFileChange {
  path: string;
  operation: "create" | "modify" | "delete";
}
export interface SubagentChildResult {
  label: string;
  role: SubagentRole;
  stopReason: string;
  turns: number;
  summary: string;
  files?: SubagentFileChange[];
}
export interface SubagentRunResult {
  summary: string;
  results: SubagentChildResult[];
  files?: SubagentFileChange[];
}

/** The parent-attempt correlation a subagent tool receives from its ToolContext. */
export interface SubagentCtx {
  scope: { sessionId: string; turnId: string; attemptId: string };
  toolCallId: string;
  emit: (ev: NewEvent) => void;
  signal: AbortSignal;
  cwd: string;
  workspaceRoot: string;
  /** Characters the wave's combined result gets in the parent's context; shared across the children. */
  resultChars?: number;
}

/** Everything the orchestrator needs, injected at the CLI edge (keeps the runtime pure w.r.t. fs). */
export interface SubagentDeps {
  client: ChatClient;
  workspace: WorkspaceContextPort;
  approve: Approver;
  parentMode: Mode;
  capabilities?: CapabilityPort;
  effort?: EffortSetting;
  /** The parent run's north-star goal — inherited so a child stays aligned to the same objective. */
  goal?: string;
  verify?: VerifyPort;
  /** The session's hooks: a child's tool calls run the tool hooks, and SubagentStop fires when it finishes. */
  hooks?: HooksPort;
  /** Checked at each child turn: true when the user wants the wave to report back now (they sent a message
   *  the parent can only read once the wave returns). */
  hurry?: () => boolean;
  /** The session's permission rules — a child obeys the same denials. */
  permissionRules?: PermissionRules;
  /** Asking the user (backs a child's `ask_user`); questions from parallel children are asked one at a time. */
  ask?: AskPort;
  /** Build a child's registry for a role — MUST NOT include the `subagent` tool (structural depth cap).
   *  `allowedTools` (from a resolved preset) further restricts the registry to that intersection. */
  buildChildRegistry: (role: SubagentRole, allowedTools?: string[]) => ToolRegistry;
  /** A durable event sink for a child's OWN session (persists to its own JSONL). */
  childSink: (childSessionId: string) => (ev: NewEvent) => void;
  /** Session-scoped artifact store for a child: given the child's session id, returns the offload/
   *  retrieve ports bound to THAT child's blob store — so a subagent's large tool outputs are recoverable via
   * read_artifact instead of lost, and its `read_artifact` builtin isn't a dead tool. */
  artifactStore?: (childSessionId: string) => {
    save: (content: string) => string | undefined;
    read: (handle: string) => string | undefined;
  };
  maxConcurrent?: number;
  now?: () => number;
  /** Override the per-role soft deadlines (ms). */
  timeoutMs?: Partial<Record<SubagentRole, number>>;
  /** Time after the soft deadline for the wrap-up turn before the child is hard-stopped (ms). */
  wrapUpGraceMs?: number;
}

/** Per-role SOFT deadlines: past this, the child's next turn is a tool-free wrap-up (it reports what it found). */
const TIMEOUT_MS: Record<SubagentRole, number> = {
  scout: 120_000,
  oracle: 180_000,
  builder: 300_000,
};
/** Per-role turn budgets. Moderate defaults so a read-heavy scout can actually finish a package pass (each
 *  read/grep burns a turn) instead of being cut off; the orchestrator can raise a child's budget per-spec via
 *  `spec.maxTurns` (bounded) when a task genuinely needs more. */
const MAX_TURNS: Record<SubagentRole, number> = { scout: 30, oracle: 30, builder: 50 };
/** Hard ceiling on an orchestrator-requested per-child `maxTurns`, so a runaway spec can't burn unbounded turns. */
const MAX_TURNS_CEILING = 80;
/** Fleet phase routing: a subagent role maps to a routed role, so an `auto` child auto-picks a
 *  role-appropriate model from the live fleet — the oracle gets a strong reviewer, a builder the best coder. */
const ROUTED_ROLE: Record<SubagentRole, RoutedRole> = {
  scout: "planner",
  oracle: "reviewer",
  builder: "executor",
};
/** Time a child gets to write its wrap-up after the soft deadline before it is hard-stopped. */
const WRAP_UP_GRACE_MS = 180_000; // ≥ a request's own first-byte allowance, so the wrap-up isn't cut off
/** Per-child report cap when the caller didn't say how much room the wave's result has. */
const DEFAULT_SUMMARY_CAP = 8_000;
/** Floor per child, so a large wave on a small model still gets usable findings (the rest is offloaded). */
const MIN_SUMMARY_CAP = 2_000;

/** A short, human target for a child's running tool row (path/pattern/query/name/url/command), from its args. */
function childToolTarget(toolName: string, args: unknown): string | undefined {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const s = (k: string): string | undefined =>
    typeof a[k] === "string" ? (a[k] as string) : undefined;
  const t =
    toolName === "bash"
      ? s("command")
      : (s("path") ?? s("pattern") ?? s("query") ?? s("name") ?? s("url") ?? s("command"));
  if (!t) return undefined;
  const flat = t.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/**
 * Run a wave of subagents concurrently (bounded), each in its OWN isolated Agent + session, re-emitting a
 * subset of each child's activity onto the PARENT stream as `subagent.*` events so the user SEES the work.
 * Returns the aggregated (hard-capped) summaries + any builder file changes. Never spawns grandchildren — the
 * child registry excludes the subagent tool.
 */
export async function runSubagents(
  specs: SubagentSpec[],
  ctx: SubagentCtx,
  deps: SubagentDeps,
): Promise<SubagentRunResult> {
  const now = deps.now ?? Date.now;
  const limit = Math.max(1, deps.maxConcurrent ?? 4);
  const results = new Array<SubagentChildResult>(specs.length);
  // Each child's report gets an equal share of the room the parent has for this result (the parent offloads
  // anything past its own budget to read_artifact, so this only keeps the split fair).
  const summaryCap =
    ctx.resultChars !== undefined
      ? Math.max(MIN_SUMMARY_CAP, Math.floor(ctx.resultChars / Math.max(1, specs.length)))
      : DEFAULT_SUMMARY_CAP;

  // Serialize child approval prompts: the parent approver has a SINGLE resolver slot, so two builder children
  // asking concurrently would clobber each other (one promise never settles). A per-run promise chain queues
  // asks cleanly while non-asking scouts stay fully parallel.
  let approveChain: Promise<unknown> = Promise.resolve();
  const gatedApprove: Approver = (req) => {
    const run = approveChain.then(() => deps.approve(req));
    approveChain = run.catch(() => undefined);
    return run;
  };
  // Questions queue the same way: the user answers one at a time.
  let askChain: Promise<unknown> = Promise.resolve();
  const gatedAsk: AskPort | undefined = deps.ask
    ? (req) => {
        const ask = deps.ask as AskPort;
        const run = askChain.then(() => ask(req));
        askChain = run.catch(() => undefined);
        return run;
      }
    : undefined;
  const childDeps: SubagentDeps = {
    ...deps,
    approve: gatedApprove,
    ...(gatedAsk ? { ask: gatedAsk } : {}),
  };

  // Announce the wave up front (one-shot) so the UI knows the EXACT size immediately — the header reads N from
  // frame one and the "wave finished" line fires exactly once even for waves larger than the concurrency limit.
  const sameRole =
    specs.length > 0 && specs.every((s) => s.role === (specs[0] as SubagentSpec).role);
  ctx.emit({
    schemaVersion: 1,
    sessionId: ctx.scope.sessionId,
    turnId: ctx.scope.turnId,
    attemptId: ctx.scope.attemptId,
    toolCallId: ctx.toolCallId,
    kind: "subagent.wave",
    count: specs.length,
    ...(sameRole ? { role: (specs[0] as SubagentSpec).role } : {}),
    labels: specs.map((s) => s.label),
  });

  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= specs.length) return;
      results[i] = await runOneChild(specs[i] as SubagentSpec, ctx, childDeps, now, summaryCap);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, specs.length) }, worker));

  const files = results.flatMap((r) => r.files ?? []);
  const summary = results.map((r) => `↳ [${r.label}] ${r.summary}`).join("\n\n");
  return { summary, results, ...(files.length > 0 ? { files } : {}) };
}

function runOneChild(
  spec: SubagentSpec,
  ctx: SubagentCtx,
  deps: SubagentDeps,
  now: () => number,
  summaryCap: number,
): Promise<SubagentChildResult> {
  const childSessionId = newSessionId();
  const role = spec.role;
  const model = spec.model ?? "auto";
  const readOnly = role !== "builder";
  const started = now();
  const durableSink = deps.childSink(childSessionId);

  const base = {
    schemaVersion: 1 as const,
    sessionId: ctx.scope.sessionId,
    turnId: ctx.scope.turnId,
    attemptId: ctx.scope.attemptId,
    toolCallId: ctx.toolCallId,
  };

  // Re-tag: persist EVERY child event to its own log, and translate a legible subset onto the PARENT stream.
  const toolNames = new Map<string, string>();
  const toolTargets = new Map<string, string>(); // toolCallId → a short target (path/pattern/…) from the args
  const filesMutated: SubagentFileChange[] = [];
  let toolCount = 0;
  const childEmit = (ev: NewEvent): void => {
    durableSink(ev);
    if (ev.kind === "file.mutation") {
      filesMutated.push({ path: ev.path, operation: ev.operation });
    } else if (ev.kind === "tool.proposed") {
      // Capture the child's target (file/pattern/query/…) from its args so the RUNNING row can show what it's
      // actually doing, not a bare verb.
      const target = childToolTarget(ev.toolName, ev.args);
      if (target) toolTargets.set(ev.toolCallId, target);
    } else if (ev.kind === "tool.started") {
      toolCount += 1;
      toolNames.set(ev.toolCallId, ev.toolName);
      const target = toolTargets.get(ev.toolCallId);
      ctx.emit({
        ...base,
        kind: "subagent.tool",
        childSessionId,
        childToolCallId: ev.toolCallId,
        toolName: ev.toolName,
        status: "running",
        ...(target ? { preview: target } : {}),
      });
    } else if (ev.kind === "tool.result") {
      ctx.emit({
        ...base,
        kind: "subagent.tool",
        childSessionId,
        childToolCallId: ev.toolCallId,
        toolName: toolNames.get(ev.toolCallId) ?? "tool",
        status: ev.ok ? "ok" : "fail",
        ...(ev.preview ? { preview: ev.preview } : {}),
      });
    }
    // NOTE: we deliberately no longer re-tag the child's per-token `assistant.delta` onto the parent stream.
    // Streaming a child's prose live drove the tall, constantly-repainting wave panel (the strobe); the child's
    // substance now lands in its `subagent.finished` summary, which commits to the parent's scrollback. The
    // child's own durable log still captures every delta via `durableSink(ev)` above.
  };

  ctx.emit({
    ...base,
    kind: "subagent.started",
    childSessionId,
    role,
    label: spec.label,
    model,
    readOnly,
    prompt: capToolResult(spec.prompt, 500),
  });

  // Linked cancellation: the parent signal aborts the child. The per-role deadline is SOFT: it flips the child
  // into a tool-free wrap-up turn so it returns partial findings; a hard stop follows after a grace period.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  ctx.signal.addEventListener("abort", onAbort);
  if (ctx.signal.aborted) ac.abort();
  let pastDeadline = false;
  const softMs = deps.timeoutMs?.[role] ?? TIMEOUT_MS[role];
  const graceMs = deps.wrapUpGraceMs ?? WRAP_UP_GRACE_MS;
  const softTimer = setTimeout(() => {
    pastDeadline = true;
  }, softMs);
  const timer = setTimeout(() => ac.abort(), softMs + graceMs);

  // Bind the child's artifact ports to its OWN session's blob store, so read_artifact resolves and a
  // subagent's truncated outputs aren't lost. Absent factory → the ports stay undefined (offload is a no-op).
  const store = deps.artifactStore?.(childSessionId);
  const childOpts: RunOptions = {
    sessionId: childSessionId,
    mode: capMode(deps.parentMode, role),
    requestedModel: model,
    maxTurns: spec.maxTurns
      ? Math.min(MAX_TURNS_CEILING, Math.max(1, Math.floor(spec.maxTurns)))
      : MAX_TURNS[role],
    cwd: ctx.cwd,
    workspaceRoot: ctx.workspaceRoot,
    signal: ac.signal,
    wrapUp: () => pastDeadline || deps.hurry?.() === true,
    emit: childEmit,
    approve: deps.approve,
    // The question says which subagent is asking.
    ...(deps.ask
      ? {
          ask: (req) =>
            (deps.ask as AskPort)({ ...req, question: `${spec.label} asks: ${req.question}` }),
        }
      : {}),
    workspace: childWorkspace(deps.workspace),
    ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
    ...(deps.effort ? { effort: deps.effort } : {}),
    ...(deps.goal ? { goal: deps.goal } : {}),
    ...(role === "builder" && deps.verify ? { verify: deps.verify } : {}),
    ...(store ? { artifact: store.save, readArtifact: store.read } : {}),
    ...(spec.instructions ? { instructions: spec.instructions } : {}),
    ...(deps.hooks ? { hooks: childHooks(deps.hooks) } : {}),
    ...(deps.permissionRules ? { permissionRules: deps.permissionRules } : {}),
    // Route by role when the model is on `auto` — including an explicit `spec.model === "auto"` that a Claude
    // preset produced (opus/sonnet/haiku map to "auto"); only a CONCRETE model id suppresses routing.
    ...(spec.model && spec.model !== "auto" ? {} : { routedRole: ROUTED_ROLE[role] }),
  };

  return new Agent(deps.client, deps.buildChildRegistry(role, spec.allowedTools))
    .run(spec.prompt, childOpts)
    .catch((e: unknown) => ({
      stopReason: "error" as const,
      turns: 0,
      finalText: `subagent error: ${(e as Error).message}`,
    }))
    .then((result) => {
      clearTimeout(timer);
      clearTimeout(softTimer);
      ctx.signal.removeEventListener("abort", onAbort);
      const summary = capToolResult(result.finalText || "(no output)", summaryCap);
      ctx.emit({
        ...base,
        kind: "subagent.finished",
        childSessionId,
        stopReason: result.stopReason,
        turns: result.turns,
        toolCount,
        summary,
        durationMs: Math.max(0, now() - started),
      });
      return {
        label: spec.label,
        role,
        stopReason: result.stopReason,
        turns: result.turns,
        summary,
        ...(filesMutated.length > 0 ? { files: filesMutated } : {}),
      };
    });
}

/**
 * The hooks a child runs: its tool calls go through the tool hooks, and its finishing is a SubagentStop (which,
 * like Stop, may send it back to work). Session and prompt hooks belong to the parent session only.
 */
export function childHooks(hooks: HooksPort): HooksPort {
  return {
    run(event, payload, signal) {
      if (event === "PreToolUse" || event === "PostToolUse")
        return hooks.run(event, payload, signal);
      if (event === "Stop") return hooks.run("SubagentStop", payload, signal);
      return Promise.resolve({});
    },
  };
}

/**
 * The workspace port a child runs with. Children never write project memory: parallel children would race to
 * overwrite MEMORY.md with their own narrow summaries. Only the parent session compounds it.
 */
export function childWorkspace(ws: WorkspaceContextPort): WorkspaceContextPort {
  return { ...ws, writeMemory: () => {} };
}
