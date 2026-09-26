import { homedir } from "node:os";
import {
  isAbsolute as isAbsolutePath,
  join as joinPath,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";
import {
  decide,
  readDeniedMatcher,
  refineBashEffects,
  resolveResource,
  ruleCovers,
} from "@amb/permissions";
import {
  type Grant,
  type NewEvent,
  type PermissionInput,
  type ToolContext,
  type ToolDefinition,
  isReadOnly,
  newToolCallId,
} from "@amb/protocol";
import {
  BackgroundJobs,
  type ToolRegistry,
  isPosixShell,
  machineShell,
  sha256,
} from "@amb/tools-core";
import { BackgroundTasks } from "./background-tasks.js";
import type { Approver, RunOptions, ToolCall } from "./ports.js";
import { linkedTargetRisk, readOnlyBashHolds } from "./read-only-bash.js";
import { previewResult } from "./tool-result-preview.js";

export interface ToolOutcome {
  /** The branded event id (tc_…) used in the durable log. */
  toolCallId: string;
  /** The provider's wire id — MUST match the assistant message's tool_calls[].id when sending the result. */
  wireId: string;
  toolName: string;
  ok: boolean;
  result: unknown;
  error?: string;
  durationMs: number;
  /** Something a hook added after the tool ran (feedback or context for the model). */
  hookNote?: string;
  /** Instructions for a folder the call reached into for the first time this run (its AGENTS.md etc.). */
  folderInstructions?: string;
  /** A hook asked to stop the whole run (`"continue": false`), with its reason. */
  halt?: string;
}

/** IDs that scope the attempt these tool calls belong to. */
export interface Scope {
  sessionId: string;
  turnId: string;
  attemptId: string;
}

/** Resolve the resource paths a tool touches (best-effort, for the workspace-boundary check). */
/** Tools that walk a folder; with no `path` they walk the whole workspace. */
const FOLDER_WALKERS = new Set(["grep", "glob", "list"]);
/** How many read-only tool calls from one reply run at the same time. */
const MAX_PARALLEL_TOOLS = 8;

/** The paths a call touches: `path`/`file`, every `edits[].path` (apply_patch), and the workspace itself for
 *  a folder walk with no path — so path rules see everything the call reaches. */
function resourcesOf(args: unknown, toolName?: string): string[] {
  const out: string[] = [];
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const key of ["path", "file"]) {
      if (typeof a[key] === "string") out.push(a[key] as string);
    }
    if (Array.isArray(a.edits)) {
      for (const e of a.edits) {
        const p = (e as { path?: unknown } | null)?.path;
        if (typeof p === "string") out.push(p);
      }
    }
  }
  if (out.length === 0 && toolName && FOLDER_WALKERS.has(toolName)) out.push(".");
  return out;
}

async function runOne(
  call: ToolCall,
  toolCallId: string,
  tool: ToolDefinition,
  opts: RunOptions,
  scope: Scope,
  grants: Grant[],
  approve: Approver,
  makeToolCtx: (toolCallId: string) => ToolContext,
  autoApproval: { streak: number; cap?: number },
): Promise<ToolOutcome> {
  // The tool's own time: the clock restarts once you've answered an approval, so waiting on you isn't counted.
  let started = Date.now();
  const dur = () => Date.now() - started;
  const emit = (ev: NewEvent) => opts.emit(ev);
  const wireId = call.id;

  // 1. validate args
  let parsed = tool.inputSchema.safeParse(call.args);
  emit({
    schemaVersion: 1,
    kind: "tool.validated",
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    toolCallId,
    ok: parsed.success,
    ...(parsed.success ? {} : { error: "invalid arguments" }),
  });
  if (!parsed.success) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: argumentRepairHint(call, parsed.error.issues),
      durationMs: dur(),
    };
  }

  // Cancelled while earlier calls ran: don't start hooks or tools nobody will wait for.
  if (opts.signal.aborted) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: "cancelled",
      durationMs: dur(),
    };
  }
  // 1b. PreToolUse hooks: may block the call, replace its arguments, or change whether it asks.
  const pre = opts.hooks
    ? await opts.hooks.run(
        "PreToolUse",
        { tool_name: tool.manifest.name, tool_input: parsed.data },
        opts.signal,
      )
    : {};
  if (pre.block || pre.halt) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: `blocked by a hook: ${pre.block ?? pre.halt}`,
      durationMs: dur(),
      ...(pre.halt ? { halt: pre.halt } : {}),
    };
  }
  if (pre.updatedInput) {
    const replaced = tool.inputSchema.safeParse(pre.updatedInput);
    if (replaced.success) parsed = replaced;
  }

  // 2. permission — honors existing session/project grants
  // A read-only bash command (git status / log / diff, ls, cat, grep …) is downgraded to a `read` effect so
  // it auto-allows and works in plan mode, instead of prompting like an arbitrary shell call. The classifier
  // is deliberately strict — any redirection / substitution / mutating form keeps the full process effects.
  // The classifier parses POSIX shell syntax; with a PowerShell-backed tool (Windows without Git Bash) its
  // quoting rules don't hold, so nothing is downgraded — every command asks as a full process call.
  const refined = isPosixShell(machineShell())
    ? refineBashEffects(tool.manifest.name, parsed.data, tool.manifest.effects)
    : tool.manifest.effects;
  // …and only when it also stays inside the workspace, off your denied files and away from git config that
  // runs programs — checks that need the disk (read-only-bash.ts).
  const effectiveEffects =
    refined !== tool.manifest.effects &&
    !readOnlyBashHolds(String((parsed.data as { command?: unknown }).command ?? ""), {
      workspaceRoot: opts.workspaceRoot,
      readDenied: makeToolCtx(toolCallId).readDenied,
    })
      ? tool.manifest.effects
      : refined;
  const readOnlyCall = effectiveEffects.length > 0 && effectiveEffects.every((e) => e === "read");
  const permInput: PermissionInput = {
    principal: "model",
    mode: opts.mode,
    toolName: tool.manifest.name,
    effects: effectiveEffects,
    normalizedArgs: parsed.data as Record<string, unknown>,
    // Resolved with the host's path rules (normalizes `..`, absolute and drive-letter paths) so the
    // outside-the-workspace check can't be walked around.
    resolvedResources: resourcesOf(parsed.data, tool.manifest.name).map((r) =>
      resolveResource(opts.workspaceRoot, r),
    ),
    workspaceRoot: opts.workspaceRoot,
    grants,
    autoApprovalStreak: autoApproval.streak,
    ...(autoApproval.cap !== undefined ? { autoApprovalCap: autoApproval.cap } : {}),
  };
  const decided = decide(permInput, opts.permissionRules ? { rules: opts.permissionRules } : {});
  // An automatic edit approval is judged again by where the paths really lead (a symlinked file).
  // (Also an allow from one of your rules — a rule for `src/**` shouldn't cover a link out of it.)
  const linked =
    decided.effect === "allow" &&
    opts.mode !== "bypass" &&
    decided.reason !== "covered by an existing grant"
      ? linkedTargetRisk(tool.manifest.name, permInput.normalizedArgs, opts.workspaceRoot)
      : [];
  const base: typeof decided =
    linked.length > 0
      ? { effect: "ask", reason: `${decided.reason}; elevated risk: ${linked.join("; ")}` }
      : decided;
  // A hook can turn a prompt into an automatic allow, or an automatic allow into a prompt — never undo a denial,
  // and never answer a question one of YOUR ask rules insists on.
  const askedByYou =
    opts.permissionRules?.ask.some((r) =>
      ruleCovers(
        r,
        {
          toolName: permInput.toolName,
          args: permInput.normalizedArgs,
          resources: permInput.resolvedResources,
          workspaceRoot: opts.workspaceRoot,
          home: homedir(),
        },
        "any",
      ),
    ) === true;
  const decision =
    base.effect === "ask" && pre.allow && !pre.ask && !askedByYou
      ? { ...base, effect: "allow" as const, reason: "allowed by a hook" }
      : base.effect === "allow" && pre.ask
        ? { ...base, effect: "ask" as const, reason: "a hook asked to confirm this" }
        : base;
  let effect = decision.effect;
  let scopeGranted: "session" | undefined;
  if (effect === "ask") {
    const ans = await approve({
      toolName: tool.manifest.name,
      args: parsed.data,
      effects: effectiveEffects,
      decision,
    });
    effect = ans === "deny" ? "deny" : "allow";
    started = Date.now();
    if (ans === "allow-session") {
      grants.push({ scope: "session", toolName: tool.manifest.name });
      scopeGranted = "session";
    }
  }
  // Autonomy-brake bookkeeping (accept-edits): a human interaction (any ask) resets the run; an unattended
  // auto-approved mutation advances the streak toward the periodic checkpoint. Reads never count.
  if (decision.effect === "ask") {
    autoApproval.streak = 0;
  } else if (decision.effect === "allow" && !readOnlyCall && !isReadOnly(tool.manifest)) {
    autoApproval.streak++;
  }
  emit({
    schemaVersion: 1,
    kind: "tool.permission",
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    toolCallId,
    effect,
    ...(scopeGranted ? { scope: scopeGranted } : {}),
    reason: decision.reason,
  });
  if (effect === "deny") {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: `denied: ${decision.reason}`,
      durationMs: dur(),
    };
  }

  // 3. execute — honor a late Ctrl-C right before the side effect
  if (opts.signal.aborted) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: "cancelled before execution",
      durationMs: dur(),
    };
  }
  emit({
    schemaVersion: 1,
    kind: "tool.started",
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    toolCallId,
    toolName: tool.manifest.name,
  });
  // Re-check AFTER recording intent: if persisting `tool.started` failed, the sink aborts the run, and
  // we must not execute a mutation whose write-ahead intent didn't land.
  if (opts.signal.aborted) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: "cancelled before execution",
      durationMs: dur(),
    };
  }
  try {
    const result = await runBounded(tool, parsed.data, makeToolCtx(toolCallId), opts.signal);
    // PostToolUse hooks see the result; what they return (feedback or context) rides along to the model.
    const afterHooks = async (o: ToolOutcome): Promise<ToolOutcome> => {
      if (!opts.hooks) return o;
      const r = await opts.hooks.run(
        "PostToolUse",
        { tool_name: tool.manifest.name, tool_input: parsed.data, tool_response: o.result },
        opts.signal,
      );
      const note = [r.block, r.context].filter(Boolean).join("\n");
      const withNote = note ? { ...o, hookNote: note } : o;
      return r.halt ? { ...withNote, halt: r.halt } : withNote;
    };
    // Validate the tool's OWN output for shape. A mismatch is OUR bug, not the model's — the side
    // effect ALREADY happened, so we must NOT report ok:false (that would invite a duplicate mutation).
    // We keep ok:true, surface the raw result, and note the mismatch.
    const outParsed = tool.outputSchema.safeParse(result);
    if (!outParsed.success) {
      return afterHooks({
        toolCallId,
        wireId,
        toolName: call.name,
        ok: true,
        result,
        error: `note: tool result did not match its output schema (${outParsed.error.message})`,
        durationMs: dur(),
      });
    }
    return afterHooks({
      toolCallId,
      wireId,
      toolName: call.name,
      ok: true,
      result: outParsed.data,
      durationMs: dur(),
    });
  } catch (err) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: (err as Error).message,
      durationMs: dur(),
    };
  }
}

/**
 * Run a tool's execute() bounded by its declared `timeoutPolicy.maximumMs`. The race guarantees the loop
 * proceeds at the deadline even if a badly-behaved tool ignores the abort signal (its promise then leaks,
 * but the run is not held hostage); a well-behaved tool cancels via the linked signal. No policy ⇒ no bound.
 */
async function runBounded(
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
  outerSignal: AbortSignal,
): Promise<unknown> {
  const maxMs = tool.manifest.timeoutPolicy?.maximumMs;
  if (!(typeof maxMs === "number" && Number.isFinite(maxMs) && maxMs > 0)) {
    return tool.execute(args, ctx);
  }
  const linked = new AbortController();
  const onOuterAbort = () => linked.abort();
  if (outerSignal.aborted) linked.abort();
  else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        linked.abort();
        reject(new Error(`tool '${tool.manifest.name}' exceeded its ${maxMs}ms limit`));
      }, maxMs);
      Promise.resolve(tool.execute(args, { ...ctx, signal: linked.signal })).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

/** A tool call may run concurrently with its neighbours only if it is read-only AND parallelSafe. */
function canRunConcurrently(tool: ToolDefinition): boolean {
  return isReadOnly(tool.manifest) && tool.manifest.parallelSafe;
}

/**
 * Execute a batch of tool calls IN ORDER, running consecutive read-only+parallelSafe calls concurrently
 * and treating any mutating (or non-parallel-safe) call as a barrier. This preserves the model's intended
 * ordering — e.g. write(x) then read(x) sees the new contents — while still parallelising safe reads.
 * Unknown tools and validation/permission failures become error outcomes (never abort the loop).
 */
export async function executeTools(
  calls: ToolCall[],
  registry: ToolRegistry,
  opts: RunOptions,
  scope: Scope,
  grants: Grant[] = [],
  autoApproval: { streak: number; cap?: number } = { streak: 0 },
  resultChars?: number,
  runState?: RunState,
): Promise<ToolOutcome[]> {
  const readRoots = runState?.readRoots;
  const rules = opts.permissionRules;
  const home = homedir();
  // Compiled once per batch: folder walks check every file they visit.
  const readDenied = rules?.deny.some((r) => r.specifier !== undefined)
    ? readDeniedMatcher(rules, opts.workspaceRoot, home)
    : undefined;
  const makeToolCtx = (toolCallId: string): ToolContext => ({
    cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot,
    signal: opts.signal,
    secret: async () => "",
    emit: opts.emit,
    ...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
    ...(opts.readArtifact ? { readArtifact: opts.readArtifact } : {}),
    // The interactive-question port (backs `ask_user`) — present only at the top level, so a subagent child
    // never blocks on a human it can't reach (its ctx omits `ask`, and the tool returns a proceed note).
    ...(opts.ask ? { ask: opts.ask } : {}),
    // Correlation for tools that author nested events (e.g. the subagent tool → subagent.* on the parent).
    scope: { sessionId: scope.sessionId, turnId: scope.turnId, attemptId: scope.attemptId },
    toolCallId,
    ...(resultChars !== undefined ? { resultChars } : {}),
    ...(readRoots
      ? { readRoots: { list: () => [...readRoots], add: (dir: string) => void readRoots.add(dir) } }
      : {}),
    ...(readDenied ? { readDenied } : {}),
    ...(runState ? { backgroundJobs: runState.jobs, backgroundTasks: runState.tasks } : {}),
  });

  const ids = calls.map((c) => (c.id.startsWith("tc_") ? c.id : newToolCallId()));
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] as ToolCall;
    opts.emit({
      schemaVersion: 1,
      kind: "tool.proposed",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      toolCallId: ids[i] as string,
      wireId: call.id,
      toolName: call.name,
      args: normalizeArgs(call.args),
      rawArgs: call.rawArgs,
      argsHash: sha256(call.rawArgs),
    });
  }

  // Emit a tool's result the MOMENT it settles (never batched at end) so a finished tool's row never
  // shows 'running', and a crash after a mutation still has both tool.started AND tool.result durable.
  // Carries the unified diff (from the tool's OUTPUT — write/edit return it) so the UI can render it, and
  // emits file.mutation for any tool that reports a {path, operation} (the durable mutation record).
  const emitResult = (o: ToolOutcome): void => {
    const preview = previewOf(o);
    const r =
      o.ok && o.result && typeof o.result === "object"
        ? (o.result as Record<string, unknown>)
        : undefined;
    const diff = typeof r?.diff === "string" && r.diff.length > 0 ? capDiff(r.diff) : undefined;
    opts.emit({
      schemaVersion: 1,
      kind: "tool.result",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      toolCallId: o.toolCallId,
      ok: o.ok,
      durationMs: o.durationMs,
      ...(o.error ? { error: o.error } : {}),
      ...(preview ? { preview } : {}),
      ...(diff ? { diff } : {}),
    });
    // Emit a durable file.mutation for each changed file. A {files:[...]} result (apply_patch) carries the
    // per-file records; otherwise a top-level {path, operation} (write/edit) is the single mutation. Prefer
    // files[] when present so a hybrid shape can't double-emit the same file.
    if (r && Array.isArray(r.files)) {
      for (const f of r.files)
        if (f && typeof f === "object") emitMutation(f as Record<string, unknown>);
    } else if (r) {
      emitMutation(r);
    }
  };

  const emitMutation = (r: Record<string, unknown>): void => {
    if (
      typeof r.path !== "string" ||
      (r.operation !== "create" && r.operation !== "modify" && r.operation !== "delete")
    ) {
      return;
    }
    opts.emit({
      schemaVersion: 1,
      kind: "file.mutation",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      path: r.path,
      operation: r.operation,
      ...(typeof r.preimageHash === "string" ? { preimageHash: r.preimageHash } : {}),
      ...(typeof r.postimageHash === "string" ? { postimageHash: r.postimageHash } : {}),
    });
  };

  const outcomes = new Array<ToolOutcome | undefined>(calls.length);
  // Once a hook stops the run, nothing else in the batch runs.
  let haltedBy: string | undefined;
  const run = async (i: number): Promise<ToolOutcome> => {
    const call = calls[i] as ToolCall;
    const toolCallId = ids[i] as string;
    if (haltedBy !== undefined) {
      return {
        toolCallId,
        wireId: call.id,
        toolName: call.name,
        ok: false,
        result: null,
        error: `not run: a hook stopped the run (${haltedBy})`,
        durationMs: 0,
      };
    }
    const outcome = await runOneOrUnknown(i, call, toolCallId);
    if (outcome.halt) haltedBy = outcome.halt;
    return outcome;
  };
  const runOneOrUnknown = (i: number, call: ToolCall, toolCallId: string): Promise<ToolOutcome> => {
    const tool = registry.get(call.name);
    if (!tool) {
      return Promise.resolve({
        toolCallId,
        wireId: call.id,
        toolName: call.name,
        ok: false,
        result: null,
        error: `unknown tool: ${call.name}`,
        durationMs: 0,
      });
    }
    return runOne(
      call,
      toolCallId,
      tool,
      opts,
      scope,
      grants,
      opts.approve,
      makeToolCtx,
      autoApproval,
    );
  };

  let i = 0;
  while (i < calls.length) {
    // Gather a run of consecutive concurrency-safe calls.
    const batch: number[] = [];
    while (i < calls.length) {
      const tool = registry.get((calls[i] as ToolCall).name);
      const safe = tool ? canRunConcurrently(tool) : false;
      if (safe) {
        batch.push(i);
        i++;
      } else {
        break;
      }
    }
    if (batch.length > 0) {
      // Emit each result the MOMENT its own call settles — a fast read in the batch must not keep its row
      // 'running' until a slow neighbour finishes. `outcomes[]` stays index-keyed for model-facing order.
      // At most MAX_PARALLEL_TOOLS at once: a reply with dozens of reads mustn't open them all together.
      let next = 0;
      const lane = async () => {
        while (next < batch.length) {
          const idx = batch[next++] as number;
          const o = await run(idx);
          outcomes[idx] = o;
          emitResult(o);
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_TOOLS, batch.length) }, lane));
    }
    if (i < calls.length) {
      const o = await run(i);
      outcomes[i] = o;
      emitResult(o);
      i++;
    }
  }

  const done = outcomes.filter((o): o is ToolOutcome => o !== undefined);
  return runState ? withFolderInstructions(done, calls, opts, runState) : done;
}

/** Folders whose own instruction files are someone else's (dependencies, vendored or generated code). */
const NOT_OURS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  ".git",
  "dist",
  "build",
  ".venv",
  "venv",
  "target",
  ".claude",
]);

/** What a run remembers across tool batches. */
export interface RunState {
  /** Background shell commands (`bash` with `background: true`). */
  jobs: BackgroundJobs;
  /** Background subagent waves, reporting back at a turn boundary. */
  tasks: BackgroundTasks;
  /** Folders outside the workspace tools may read (a loaded skill's own files). */
  readRoots: Set<string>;
  /** Folders whose own instruction files were already offered this run. */
  instructionDirs: Set<string>;
}

export function newRunState(): RunState {
  return {
    jobs: new BackgroundJobs(),
    tasks: new BackgroundTasks(),
    readRoots: new Set(),
    instructionDirs: new Set(),
  };
}

/**
 * The first time a call reaches into a folder below the working directory, that folder's own instruction
 * files (AGENTS.md, CLAUDE.md, …) ride along with the result — so a monorepo package's rules apply when the
 * agent starts working there, without loading every package's rules up front.
 */
function withFolderInstructions(
  outcomes: ToolOutcome[],
  calls: ToolCall[],
  opts: RunOptions,
  state: RunState,
): ToolOutcome[] {
  const load = opts.workspace?.folderInstructions;
  if (!load) return outcomes;
  const base = resolvePath(opts.cwd);
  return outcomes.map((o, i) => {
    if (!o.ok) return o;
    const notes: string[] = [];
    for (const r of resourcesOf(calls[i]?.args)) {
      const abs = resolveResource(opts.workspaceRoot, r);
      const rel = relativePath(base, abs);
      if (!rel || rel.startsWith("..") || isAbsolutePath(rel)) continue;
      // Every folder from just below the working directory down to the one the file is in.
      const parts = rel.split(/[\\/]/);
      const dirParts = o.toolName === "list" ? parts : parts.slice(0, -1);
      for (let d = 1; d <= dirParts.length; d++) {
        if (NOT_OURS.has(dirParts[d - 1] as string)) break;
        const dir = joinPath(base, ...dirParts.slice(0, d));
        if (state.instructionDirs.has(dir)) continue;
        state.instructionDirs.add(dir);
        const text = load(dir);
        if (text)
          notes.push(
            `Instructions for ${dirParts.slice(0, d).join("/")}/ (follow them while working there):\n${text}`,
          );
      }
    }
    return notes.length > 0 ? { ...o, folderInstructions: notes.join("\n\n") } : o;
  });
}

/** Never store `undefined` in an event (breaks the checksum canonicalizer vs JSON.stringify). */
function normalizeArgs(args: unknown): unknown {
  return args === undefined ? null : args;
}

const MAX_DIFF_LINES = 500; // hard ceiling on the STORED diff, INCLUDING any truncation marker line
const MAX_DIFF_CHARS = 64_000;
/**
 * Bound the emitted diff so a pathological write (a multi-MB file) can't put a huge string in the durable
 * log or make every Ink rerender re-split it. Reserves ONE line for a single honest marker if EITHER the
 * char-cap or the line-cap fired, so the result is always ≤ MAX_DIFF_LINES and never silently under-marks.
 */
function capDiff(diff: string): string {
  const charTruncated = diff.length > MAX_DIFF_CHARS;
  const base = charTruncated ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const lines = base.split("\n");
  const lineTruncated = lines.length > MAX_DIFF_LINES; // EXCEEDS the ceiling (exactly 500 is fine as-is)
  if (!charTruncated && !lineTruncated) return diff;
  // A marker line WILL be added, so keep at most MAX_DIFF_LINES-1 real lines → total is always ≤ the ceiling
  // (slice keeps fewer when the base is short). Generic marker: the exact remaining count is unreliable once
  // chars were sliced first.
  const kept = lines.slice(0, MAX_DIFF_LINES - 1);
  return `${kept.join("\n")}\n… (diff truncated)`;
}

function previewOf(o: ToolOutcome): string | undefined {
  // Tool-aware, human-readable preview (file contents / stdout / matches …) — NEVER a raw JSON envelope.
  return previewResult(o.toolName, o.result, o.error);
}

/**
 * A specific, actionable message for a call whose arguments failed validation, so the model can fix the call
 * on the next turn instead of guessing: malformed JSON quotes what it sent; a schema miss names each field.
 */
export function argumentRepairHint(
  call: { name: string; args: unknown; rawArgs: string },
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  if (call.args === undefined) {
    const raw = call.rawArgs.length > 300 ? `${call.rawArgs.slice(0, 300)}…` : call.rawArgs;
    return `invalid arguments: your arguments for \`${call.name}\` were not valid JSON (${raw}). Re-send the call with a single complete JSON object.`;
  }
  const fields = issues
    .slice(0, 6)
    .map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(arguments)"}: ${i.message}`)
    .join("; ");
  return `invalid arguments for \`${call.name}\`: ${fields}. Fix these fields and call it again.`;
}
