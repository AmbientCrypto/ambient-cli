import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { resolveConfig } from "@amb/ambient-api";
import {
  type EvalReport,
  type RunTaskOutcome,
  compareToBaseline,
  evalGate,
  formatReport,
  parseReport,
  parseSuiteJson,
  runEvalSuite,
} from "@amb/evals";
import { AmbError, type NewEvent, newSessionId } from "@amb/protocol";
import { AUTO_MODEL } from "@amb/reliability";
import { Agent, type RunOptions } from "@amb/runtime";
import { SessionWriter, readObject, saveObject } from "@amb/sessions";
import { ToolRegistry, createBuiltinRegistry, resolveInWorkspace } from "@amb/tools-core";
import { AmbientChatClient } from "../agent/ambient-client.js";
import { makeCapabilityPort } from "../agent/capability-port.js";
import { makeVerifyPort } from "../agent/verify-port.js";
import { resolveWorkingApiKey } from "../agent/working-key.js";
import { makeWorkspaceContextPort } from "../agent/workspace-context-port.js";
import { bold, dim } from "../render/color.js";
import { NOT_SIGNED_IN } from "../secrets.js";

/** Per-task wall-clock deadline: bounds a stalled catalog/SSE that `maxTurns` (iteration count) can't. */
const TASK_DEADLINE_MS = 300_000;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

// The eval AGENT's tools — an EXPLICIT allowlist (safer than a denylist: a future builtin can't quietly widen
// the surface). Only workspace-scoped file tools (all path-firewalled via resolveInWorkspace) + the read-only
// plan/read_artifact + remember (writes inside the scratch .ambient). Deliberately OMITS: bash (process),
// web_* (network), subagent (spawns agents), and `skill` (reads global ~/.claude files — not hermetic).
// NOTE: this is NOT an OS sandbox. `amb eval` still executes code — a `command_succeeds` check runs a command,
// and the agent can WRITE a file that command then executes. That is the SAME trust model as `npm test` / CI:
// run suites you trust. A real OS sandbox (rooted at the scratch dir) is a future follow-up that would make
// running untrusted suites safe.
const EVAL_AGENT_TOOLS = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "write",
  "edit",
  "apply_patch",
  "plan",
  "remember",
  "read_artifact",
]);
function evalAgentRegistry(): ToolRegistry {
  const full = createBuiltinRegistry();
  const reg = new ToolRegistry();
  for (const t of full.list()) if (EVAL_AGENT_TOOLS.has(t.manifest.name)) reg.register(t);
  return reg;
}

/**
 * Instruction files read from the scratch ROOT ONLY — never ancestor-walked. loadInstructions() walks up to
 * the nearest `.git` (or `/`), but a scratch dir has no `.git`, so it would pull a host `AGENTS.md`/`CLAUDE.md`
 * into the eval prompt and make results non-reproducible. A task seeds its own via setup.files.
 */
function evalInstructions(root: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = readFileSync(resolveInWorkspace(root, name), "utf8").trim();
      if (text) return text;
    } catch {
      /* absent → next */
    }
  }
  return "";
}

interface EvalArgs {
  name?: string;
  model: string;
  maxTurns: number;
  minPassRate?: number;
  useBaseline: boolean;
  saveBaseline: boolean;
  json: boolean;
  error?: string;
}

function parseArgs(args: string[]): EvalArgs {
  let name: string | undefined;
  let model = AUTO_MODEL;
  let maxTurns = 20;
  let minPassRate: number | undefined;
  let useBaseline = false;
  let saveBaseline = false;
  let json = false;
  let error: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model" || a === "-m") model = args[++i] ?? model;
    else if (a === "--baseline") useBaseline = true;
    else if (a === "--save-baseline") saveBaseline = true;
    else if (a === "--json") json = true;
    else if (a === "--min-pass-rate") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v < 0 || v > 1) error = "--min-pass-rate needs a number in [0,1]";
      else minPassRate = v;
    } else if (a === "--max-turns") {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 1000) error = "--max-turns needs an integer 1–1000";
      else maxTurns = v;
    } else if (a?.startsWith("-")) error = `unknown flag: ${a}`;
    else if (a) {
      // The name becomes a path component for the suite + baseline files — keep it a bare, safe basename so
      // a `../` or absolute name can't resolve/write outside .ambient/evals.
      if (!SAFE_NAME.test(a)) error = `invalid suite name "${a}" (use letters, digits, . _ -)`;
      else name = a;
    }
  }
  // Comparing to the OLD baseline while overwriting it in the SAME run would let a regression replace the good
  // baseline with the failing result. These intents are contradictory — refuse the combination.
  if (useBaseline && saveBaseline)
    error =
      "--baseline and --save-baseline are mutually exclusive (compare OR re-baseline, not both)";
  return { name, model, maxTurns, minPassRate, useBaseline, saveBaseline, json, error };
}

const evalsDir = (cwd: string) => join(cwd, ".ambient", "evals");

/** Resolve the suite file: an explicit name → `<name>.json`; else the sole `*.json` (excluding baselines). */
function resolveSuiteFile(
  cwd: string,
  name?: string,
): { file: string; name: string } | { error: string } {
  const dir = evalsDir(cwd);
  if (name) {
    const file = join(dir, `${name}.json`);
    return existsSync(file)
      ? { file, name }
      : { error: `no eval suite at .ambient/evals/${name}.json` };
  }
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".baseline.json"))
    : [];
  if (files.length === 0)
    return { error: "no eval suites in .ambient/evals/ — add <name>.json (see docs/evals.md)" };
  if (files.length > 1)
    return {
      error: `multiple suites in .ambient/evals/ — name one: ${files.map((f) => f.replace(/\.json$/, "")).join(", ")}`,
    };
  const only = files[0] as string;
  return { file: join(dir, only), name: only.replace(/\.json$/, "") };
}

/** `ambient eval [name] [--model m] [--min-pass-rate r] [--baseline] [--save-baseline] [--json]`.
 *  Runs the repo's private eval suite as a ship gate: each task runs the agent in an isolated scratch
 *  workspace, then deterministic checks decide pass/fail. Exits non-zero when the gate blocks. */
export async function runEval(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.error) {
    process.stderr.write(`ambient: ${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const resolved = resolveSuiteFile(cwd, parsed.name);
  if ("error" in resolved) {
    process.stderr.write(`ambient: ${resolved.error}\n`);
    process.exitCode = 1;
    return;
  }

  let suite: ReturnType<typeof parseSuiteJson>;
  try {
    suite = parseSuiteJson(readFileSync(resolved.file, "utf8"), resolved.name);
  } catch (err) {
    process.stderr.write(`ambient: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  // A rejected saved key falls back to another key on this machine that works (and says so).
  const working = await resolveWorkingApiKey(resolveConfig().baseUrl);
  if (working?.note) process.stderr.write(`${working.note}\n`);
  const apiKey = working?.key;
  if (!apiKey) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`);
    process.exitCode = 1;
    return;
  }

  const baselineFile = join(evalsDir(cwd), `${resolved.name}.baseline.json`);
  let baseline: EvalReport | undefined;
  if (parsed.useBaseline) {
    if (!existsSync(baselineFile)) {
      process.stderr.write(
        `ambient: --baseline given but no ${resolved.name}.baseline.json yet (run with --save-baseline first)\n`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      baseline = parseReport(JSON.parse(readFileSync(baselineFile, "utf8"))); // validated, not cast
    } catch (err) {
      process.stderr.write(`ambient: unreadable baseline: ${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const client = new AmbientChatClient({ baseUrl: resolveConfig().baseUrl, apiKey });
  const controller = new AbortController();
  // Track every live scratch dir so a FORCED exit (2nd SIGINT, SIGTERM, SIGHUP — none of which unwind the
  // finally that normally tears them down) still removes them synchronously. No scratch dir leaks (disk-
  // hygiene HARD RULE). SIGKILL remains inherently uncatchable — nothing can help there.
  const activeWs = new Set<string>();
  // A HERMETIC workspace context for evals: instructions from the scratch root only (no ancestor walk) and NO
  // global skill discovery — so a host AGENTS.md or ~/.claude skill can't leak into the eval prompt and make a
  // ship-gate non-reproducible. Everything else (memory/repoMap over the scratch dir, date, platform)
  // reuses the real port.
  const evalWorkspace = {
    ...makeWorkspaceContextPort(),
    instructions: (root: string) => evalInstructions(root),
    skills: () => [],
  };
  const purgeAndExit = (code: number) => {
    for (const d of activeWs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort — a leaked dir is bad, but crashing the exit path is worse */
      }
    }
    process.exit(code);
  };
  const onForceSigint = () => purgeAndExit(130); // a SECOND Ctrl-C forces exit — purge first
  const onSigint = () => {
    controller.abort(); // graceful: let the in-flight task unwind + clean up
    process.once("SIGINT", onForceSigint);
  };
  const onTerm = () => purgeAndExit(143); // 128 + SIGTERM(15)
  const onHup = () => purgeAndExit(129); // 128 + SIGHUP(1)
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onTerm);
  process.once("SIGHUP", onHup);

  if (!parsed.json)
    process.stderr.write(
      `${bold("ambient eval")} ${dim(`· ${resolved.name} · ${suite.tasks.length} task(s) · ${parsed.model}`)}\n`,
    );

  /** Run ONE task in a fresh scratch workspace; cleans up on failure, hands cleanup to the runner on success. */
  const runTask = async (task: (typeof suite.tasks)[number]): Promise<RunTaskOutcome> => {
    // mkdtempSync (not async) so the dir is registered for the forced-exit purge with NO window between its
    // creation and activeWs.add — a signal can't slip in between.
    const ws = mkdtempSync(join(tmpdir(), "amb-eval-"));
    activeWs.add(ws);
    // Per-task signal = the global abort OR a wall-clock deadline. AbortSignal.any also fires immediately if the
    // global is ALREADY aborted (e.g. SIGINT arrived before this task started) — a manual addEventListener would
    // miss that and let the task hang to its deadline (a cancellation gap).
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TASK_DEADLINE_MS)]);
    try {
      for (const f of task.setup?.files ?? []) {
        const abs = resolveInWorkspace(ws, f.path); // path-firewalled: a `../escape` fixture path is refused
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      const sessionId = newSessionId();
      const writer = new SessionWriter(sessionId, () => new Date().toISOString());
      let servedModel: string | undefined;
      const emit = (ev: NewEvent) => {
        try {
          writer.append(ev);
        } catch {
          /* the eval's verdict is the load-bearing output; a child-log miss is non-fatal */
        }
        if (ev.kind === "model.resolved") servedModel = (ev as { targetModel: string }).targetModel;
      };
      const opts: RunOptions = {
        sessionId,
        // bypass = no approval prompts (evals are non-interactive). The eval registry excludes bash/network/
        // subagent, so the agent can only touch files inside the path-firewalled scratch workspace — there is
        // nothing dangerous to auto-approve. (The `command_succeeds` CHECK still executes code — see
        // EVAL_AGENT_TOOLS: this is not an OS sandbox; run trusted suites only.)
        mode: "bypass",
        requestedModel: parsed.model,
        maxTurns: parsed.maxTurns,
        cwd: ws,
        workspaceRoot: ws,
        signal,
        emit,
        approve: async () => "allow-once",
        capabilities: makeCapabilityPort(),
        workspace: evalWorkspace,
        verify: makeVerifyPort(ws, () => true), // the suite's own fixture, run on purpose
        checkpoint: (content) => saveObject(sessionId, content),
        artifact: (content) => saveObject(sessionId, content),
        readArtifact: (handle) => readObject(sessionId, handle),
      };
      const result = await new Agent(client, evalAgentRegistry()).run(task.prompt, opts);
      if (!parsed.json) process.stderr.write(dim(`  ran ${task.id} → ${result.stopReason}\n`));
      return {
        finalText: result.finalText,
        stopReason: result.stopReason,
        ...(servedModel ? { model: servedModel } : {}),
        readFile: (rel) => {
          try {
            return readFileSync(resolveInWorkspace(ws, rel), "utf8");
          } catch {
            return undefined;
          }
        },
        runCommand: async (command) => {
          const r = spawnSync(command, {
            cwd: ws,
            shell: true,
            encoding: "utf8",
            timeout: 120_000,
            killSignal: "SIGKILL", // a command that traps SIGTERM can't dodge the timeout
          });
          // A spawn error (ETIMEDOUT/ENOENT) or a killed-by-signal command is a FAILURE regardless of `status`
          // — a process killed at the deadline can still report status 0 via a trap.
          if (r.error || r.signal) return 1;
          return r.status ?? 1; // null status (no exit) counts as a failure
        },
        // Untrack only AFTER the delete actually completes — if a forced signal lands mid-rm, the dir is still
        // in activeWs and the synchronous purge removes it; if rm rejects, it stays tracked.
        cleanup: async () => {
          await rm(ws, { recursive: true, force: true, maxRetries: 5 });
          activeWs.delete(ws);
        },
      };
    } catch (err) {
      await rm(ws, { recursive: true, force: true, maxRetries: 5 }); // never leak the scratch dir on a throw
      activeWs.delete(ws);
      throw err;
    }
  };

  try {
    const report = await runEvalSuite(suite, { runTask });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`\n${formatReport(report)}\n`);
      if (baseline) {
        const diff = compareToBaseline(report, baseline);
        if (diff.fixed.length)
          process.stdout.write(dim(`  fixed since baseline: ${diff.fixed.join(", ")}\n`));
      }
    }
    if (parsed.saveBaseline) {
      const dir = evalsDir(cwd);
      mkdirSync(dir, { recursive: true });
      // Refuse if .ambient/evals resolves OUTSIDE the repo (a symlinked ancestor) — the write must not escape
      // the repo, and rmSync/rename must not touch an external dir.
      const realCwd = realpathSync(cwd);
      const realDir = realpathSync(dir);
      if (realDir !== realCwd && !realDir.startsWith(realCwd + sep)) {
        process.stderr.write(
          "ambient: refusing to save baseline — .ambient/evals resolves outside the repo\n",
        );
        process.exitCode = 1;
      } else {
        // Atomic + symlink-safe: a UNIQUE same-dir temp (concurrent --save-baseline runs can't clobber each
        // other) created with O_CREAT|O_EXCL (`wx`, never follows a symlink), then rename over
        // the baseline (replaces a symlink target, never follows it). finally removes our temp so a failed
        // write/rename can't orphan it; the unique name means cleanup only touches our own file.
        const tmp = join(dir, `${resolved.name}.baseline.${process.pid}.${randomUUID()}.tmp`);
        try {
          writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
          renameSync(tmp, baselineFile);
          if (!parsed.json)
            process.stderr.write(dim(`  saved baseline → ${resolved.name}.baseline.json\n`));
        } finally {
          rmSync(tmp, { force: true });
        }
      }
    }
    const verdict = evalGate(report, {
      ...(parsed.minPassRate !== undefined ? { minPassRate: parsed.minPassRate } : {}),
      ...(baseline ? { baseline } : {}),
    });
    if (verdict.blocked) {
      if (!parsed.json)
        for (const r of verdict.reasons)
          process.stderr.write(`ambient: ship gate BLOCKED — ${r}\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(
      `\namb: ${err instanceof AmbError ? err.message : (err as Error).message}\n`,
    );
    process.exitCode = 1;
  } finally {
    // Backstop: any workspace whose async rm rejected (or never ran) is still tracked — purge it synchronously
    // so a failed teardown can't leak a scratch dir past process exit (disk-hygiene HARD RULE).
    for (const d of activeWs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    activeWs.clear();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGINT", onForceSigint); // added on the 1st SIGINT; remove so it can't leak
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGHUP", onHup);
  }
}
