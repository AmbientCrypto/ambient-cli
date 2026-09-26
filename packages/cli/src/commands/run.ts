import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolveConfig } from "@amb/ambient-api";
import {
  IMAGE_EDGE_HIGH,
  discoverAgents,
  discoverCommands,
  discoverSkills,
  mcpServersFromFlag,
} from "@amb/context";
import { type PermissionRules, parseRules } from "@amb/permissions";
import { AmbError, type ImageAttachment, type NewEvent, newSessionId } from "@amb/protocol";
import { Agent, type RunOptions } from "@amb/runtime";
import { SessionWriter, readObject, saveObject } from "@amb/sessions";
import { AmbientChatClient } from "../agent/ambient-client.js";
import { makeInteractiveApprover } from "../agent/approver.js";
import { makeInteractiveAsker } from "../agent/asker.js";
import { makeCapabilityPort } from "../agent/capability-port.js";
import { expandSlashCommand } from "../agent/command-expand.js";
import { createDurableEventSink } from "../agent/event-sink.js";
import { HeadlessOutput } from "../agent/headless-output.js";
import { fireAndForget } from "../agent/hooks.js";
import { makeImageLoader } from "../agent/load-image.js";
import { type McpConnection, connectMcp } from "../agent/mcp-connect.js";
import { buildRegistry } from "../agent/registry.js";
import { EventRenderer } from "../agent/render-events.js";
import { type ResumeContext, loadResumeContext } from "../agent/resume-context.js";
import { makeSubagentTool } from "../agent/subagent-tool.js";
import { makeVerifyPort } from "../agent/verify-port.js";
import { resolveWorkingApiKey } from "../agent/working-key.js";
import { makeWorkspaceContextPort } from "../agent/workspace-context-port.js";
import { untrustedNote, workspaceSettings } from "../agent/workspace-settings.js";
import { configDir, grantsFromConfig, loadConfig } from "../config.js";
import { makeMcpAuth } from "../mcp-auth/auth-port.js";
import { bold, dim } from "../render/color.js";
import { KEY_REJECTED, NOT_SIGNED_IN, resolveApiKey } from "../secrets.js";
import { attachImageFile, downscaleForWindow } from "../tui/capture.js";
import { checkForUpdate, updateHint } from "../update-check.js";
import { signInInteractive } from "./login.js";
import { type RunArgs, USAGE, parseRunArgs } from "./run-args.js";
import { mergeStdin, readPipedStdin } from "./stdin.js";

/** How a run reports: the live line UI, native event lines (`--jsonl`), or quiet (`-p` / JSON formats). */
type Reporting = "live" | "jsonl" | "quiet";

function reportingFor(a: RunArgs): Reporting {
  if (a.jsonl) return "jsonl";
  return a.print || a.outputFormat !== "text" ? "quiet" : "live";
}

/** How long a signalled run gets to wind down before ambient exits anyway. */
const FORCE_EXIT_MS = 5_000;

/**
 * A task that starts with `/name` runs that custom command or skill, the same as typing it in the TUI.
 * Returns the task unchanged when it isn't a command, or an error for an unknown one.
 */
export function expandTaskCommand(
  task: string,
  cwd: string,
  rules: PermissionRules | undefined,
  projectTrusted = false,
): { task: string } | { error: string } {
  const m = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(task.trim());
  if (!m?.[1]) return { task };
  const name = m[1];
  const args = m[2] ?? "";
  const command = discoverCommands(cwd).find((c) => c.name === name);
  const skill = command ? undefined : discoverSkills(cwd).find((s) => s.name === name);
  if (!command && !skill) {
    // "/tmp is full": a real path on disk is a task about that path, not a mistyped command.
    return existsSync(`/${name}`) ? { task } : { error: `unknown command /${name}` };
  }
  const words = [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (w) => w[1] ?? w[2] ?? w[3] ?? "",
  );
  const def = command ?? {
    name,
    body: `Use the "${name}" skill: load it with the skill tool and follow its instructions.\n\n$ARGUMENTS`,
    source: "user" as const,
  };
  return {
    task: expandSlashCommand(def, words, {
      workspaceRoot: cwd,
      home: homedir(),
      ...(rules ? { rules } : {}),
      projectTrusted,
    }),
  };
}

/** The config's rules plus this run's `--allowedTools` / `--disallowedTools`. */
export function withFlagRules(
  rules: PermissionRules | undefined,
  allowed: string[],
  disallowed: string[],
): PermissionRules | undefined {
  if (allowed.length + disallowed.length === 0) return rules;
  return {
    allow: [...(rules?.allow ?? []), ...parseRules(allowed)],
    deny: [...(rules?.deny ?? []), ...parseRules(disallowed)],
    ask: rules?.ask ?? [],
  };
}

async function attachImages(paths: string[], sessionId: string): Promise<ImageAttachment[]> {
  // A vision-capable model sees them; a blind model gets the vision-relay description (same path as the TUI).
  const out: ImageAttachment[] = [];
  for (const p of paths) {
    const res = await attachImageFile(p, "file");
    if (!res.ok) {
      process.stderr.write(`ambient: skipping --image ${p}: ${res.reason}\n`);
      continue;
    }
    const sized = await downscaleForWindow(res.attachment, IMAGE_EDGE_HIGH);
    saveObject(sessionId, sized.dataBase64); // offload bytes for resume; never in the event log
    out.push(sized);
  }
  return out;
}

async function signedInKey(): Promise<string | undefined> {
  // No key in an interactive terminal: sign in right here, then carry on with the task.
  if (!resolveApiKey() && process.stdin.isTTY && process.stdout.isTTY) {
    await signInInteractive({ firstRun: true });
  }
  // With more than one key on this machine, use one Ambient accepts (a revoked saved key falls back).
  const working = await resolveWorkingApiKey(resolveConfig().baseUrl);
  if (working?.note) process.stderr.write(`${working.note}\n`);
  return working?.key;
}

function fail(message: string): void {
  process.stderr.write(`ambient: ${message}\n`);
  process.exitCode = 1;
}

/** `ambient run "<task>"` (also bare `ambient "<task>"` and `ambient -p "<task>"`) — run the agent to the end. */
export async function runAgent(args: string[]): Promise<void> {
  const userConfig = loadConfig();
  const a = parseRunArgs(args, userConfig);
  // `--help` must print usage WITHOUT signing in, connecting MCP servers, or sending a billed request.
  if (a.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (a.error) return fail(a.error);
  const reporting = reportingFor(a);
  const live = reporting === "live";
  const cwd = process.cwd();

  // Fold PIPED stdin into the task so `cat err.log | amb "explain this"` works (a TTY is never read).
  const piped = mergeStdin(a.task, await readPipedStdin());
  if (!piped) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const settings = workspaceSettings(cwd, userConfig, configDir());
  const permissionRules = withFlagRules(settings.rules(), a.allowedTools, a.disallowedTools);
  const expanded = expandTaskCommand(piped, cwd, permissionRules, settings.projectTrusted());
  if ("error" in expanded) return fail(expanded.error);
  const finalTask = expanded.task;

  let resumed: ResumeContext | undefined;
  if (a.resume) {
    const r = loadResumeContext(a.resume.from, a.resume.here ? { workspaceRoot: cwd } : {});
    if ("error" in r) return fail(r.error);
    resumed = r;
  }

  let extraMcp: ReturnType<typeof mcpServersFromFlag> = [];
  try {
    extraMcp = a.mcpConfigs.flatMap((v) => mcpServersFromFlag(v, cwd));
  } catch (e) {
    return fail((e as Error).message);
  }

  const apiKey = await signedInKey();
  if (!apiKey) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`);
    process.exitCode = 1;
    return;
  }

  const client = new AmbientChatClient({ baseUrl: resolveConfig().baseUrl, apiKey });
  const sessionId = newSessionId(); // a UNIQUE session per run; a resumed one never mutates the prior log
  const writer = new SessionWriter(sessionId, () => new Date().toISOString());
  const renderer = new EventRenderer();
  const machine =
    a.outputFormat === "json" || a.outputFormat === "stream-json"
      ? new HeadlessOutput(a.outputFormat, sessionId)
      : undefined;

  const controller = new AbortController();
  const onSigint = () => {
    if (live) process.stderr.write(dim("\n(cancelling — press Ctrl-C again to force quit)\n"));
    controller.abort();
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onSigint);
  // A terminal closing or a `kill` cancels the run the same way, so its cleanup (background commands and
  // subagents it started) happens before ambient exits; a run that won't wind down is forced after a moment.
  let signalled: number | undefined;
  const onTerminate = (code: number) => () => {
    signalled = code;
    controller.abort();
    process.exitCode = code;
    setTimeout(() => process.exit(code), FORCE_EXIT_MS).unref();
  };
  const onSigterm = onTerminate(143);
  const onSighup = onTerminate(129);
  process.once("SIGTERM", onSigterm);
  process.once("SIGHUP", onSighup);

  // A persistence failure ABORTS the run: if we can't durably record intent, we must not keep executing
  // mutations. Ambient rejecting the key gets one clear, actionable line at the end of the run.
  let keyRejected = false;
  const emit = createDurableEventSink({
    writer,
    consume: (ev: NewEvent) => {
      if (ev.kind === "error" && ev.errorKind === "auth") keyRejected = true;
      if (reporting === "jsonl") {
        if (
          ev.kind !== "assistant.delta" &&
          ev.kind !== "reasoning.delta" &&
          ev.kind !== "tool.drafting"
        ) {
          process.stdout.write(`${JSON.stringify(ev)}\n`);
        }
      } else if (live) renderer.handle(ev);
      machine?.handle(ev);
    },
    onWriteError: (err) => {
      if (live)
        process.stderr.write(dim(`\n(session log write failed: ${err.message} — aborting)\n`));
      controller.abort();
    },
  });

  const attachments = await attachImages(a.images, sessionId);
  if (live)
    process.stderr.write(
      `${bold("ambient")} ${dim(`· ${a.mode} · ${a.model} · effort ${a.effort}${attachments.length ? ` · ${attachments.length} image(s)` : ""} · ${cwd} · ${sessionId}`)}\n`,
    );
  if (resumed) {
    emit({
      schemaVersion: 1,
      kind: "session.resumed",
      sessionId,
      ...(resumed.priorLastEventId ? { fromEventId: resumed.priorLastEventId } : {}),
    });
    if (live) {
      process.stderr.write(dim(`  continuing ${resumed.fromSessionId}\n`));
      if (resumed.droppedTail > 0)
        process.stderr.write(
          dim(
            `  the prior session ended abruptly (${resumed.droppedTail} unfinished log line${resumed.droppedTail === 1 ? "" : "s"})\n`,
          ),
        );
      for (const n of resumed.recoveryNotes) process.stderr.write(dim(`  recovery: ${n}\n`));
    }
  }
  // A `--goal` (or the resumed session's) is the run's north-star: record it durably so a resume keeps it.
  const goal = a.goal ?? resumed?.goal;
  if (goal) {
    emit({ schemaVersion: 1, kind: "goal.set", sessionId, text: goal });
    if (live) process.stderr.write(dim(`  ◎ goal: ${goal}\n`));
  }

  const hooks = settings.hooksPort(() => sessionId);
  const note = untrustedNote(settings);
  // Said in every mode (on stderr): a script on a fresh machine should learn why the project's settings are off.
  if (note && reporting !== "jsonl")
    process.stderr.write(live ? dim(`  ${note}\n`) : `ambient: ${note}\n`);

  const opts: RunOptions = {
    sessionId,
    mode: a.mode,
    requestedModel: a.model,
    maxTurns: a.maxTurns,
    autoContinue: a.autoContinue,
    maxAutoContinues: a.maxAutoContinues,
    cwd,
    workspaceRoot: cwd,
    signal: controller.signal,
    emit,
    // Print mode never prompts, even in a terminal: tools not allowed are refused.
    approve: makeInteractiveApprover({ autoAllow: a.autoAllow, interactive: live }),
    // Seed the persistent allowlist (config `allow`) as session grants so those tools don't re-prompt.
    grants: grantsFromConfig(userConfig),
    // `ask_user` opens a stdin questionnaire only when someone is there to answer it.
    ...(process.stdin.isTTY && live ? { ask: makeInteractiveAsker() } : {}),
    capabilities: makeCapabilityPort(),
    workspace: makeWorkspaceContextPort(undefined, {
      userInstructions: userConfig.claudeSettings === true,
    }),
    verify: makeVerifyPort(cwd, () => settings.projectTrusted()),
    checkpoint: (content) => saveObject(sessionId, content),
    artifact: (content) => saveObject(sessionId, content), // offload large tool outputs
    readArtifact: (handle) => readObject(sessionId, handle),
    loadImage: makeImageLoader(sessionId),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(goal ? { goal } : {}),
    ...(resumed ? { resumeContext: resumed.context } : {}),
    ...(a.appendSystemPrompt ? { instructions: a.appendSystemPrompt } : {}),
    ...(hooks ? { hooks } : {}),
    ...(permissionRules ? { permissionRules } : {}),
    effort: a.effort,
  };

  // `--no-mcp` (or AMBIENT_NO_MCP=1) skips discovery and spawning for a lean run with only built-in tools.
  const skipMcp = a.noMcp || process.env.AMBIENT_NO_MCP === "1";
  const mcp: Pick<McpConnection, "tools" | "notices" | "close"> = skipMcp
    ? { tools: [], notices: [], close: () => {} }
    : await connectMcp(cwd, {
        // A project's own servers connect once the project's settings are trusted (/trust).
        approveServer: async () => settings.projectTrusted(),
        projectPlugins: () => settings.projectTrusted(),
        plugins: userConfig.claudeSettings === true,
        auth: makeMcpAuth(),
        extra: extraMcp,
        strict: a.strictMcp,
      });
  if (live) for (const n of mcp.notices) process.stderr.write(dim(`  ${n}\n`));

  try {
    // Build the registry INSIDE the try so a dup-tool-id throw still reaches `finally` → mcp.close().
    const registry = buildRegistry({
      mcpTools: mcp.tools,
      subagent: makeSubagentTool({
        presets: discoverAgents(cwd),
        client,
        workspace: opts.workspace,
        approve: opts.approve,
        parentMode: opts.mode,
        ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.goal ? { goal: opts.goal } : {}),
        ...(opts.verify ? { verify: opts.verify } : {}),
        ...(hooks ? { hooks } : {}),
        ...(permissionRules ? { permissionRules } : {}),
        mcpTools: () => mcp.tools,
        ...(opts.ask ? { ask: opts.ask } : {}),
      }),
    });
    machine?.init({
      cwd,
      model: a.model,
      permissionMode: a.mode,
      tools: registry.list().map((t) => t.manifest.name),
    });
    // The update check runs alongside the run so the end-of-run nudge adds no exit latency (live UI only).
    const updateCheck = live ? checkForUpdate({ enabled: userConfig.checkUpdates }) : null;
    const result = await new Agent(client, registry).run(finalTask, opts);
    if (reporting === "jsonl") {
      process.stdout.write(
        `${JSON.stringify({ kind: "result", sessionId, stopReason: result.stopReason, turns: result.turns, finalText: result.finalText })}\n`,
      );
    } else if (machine) machine.result(result);
    else if (reporting === "quiet") process.stdout.write(`${result.finalText.trim()}\n`);
    else process.stdout.write(`\n${dim(`[${result.stopReason} · ${result.turns} turn(s)]`)}\n`);
    if (keyRejected && reporting !== "jsonl") process.stderr.write(`\n${KEY_REJECTED}\n`);
    // Non-success stop reasons must set a nonzero exit code for scripts/CI.
    if (result.stopReason !== "complete")
      process.exitCode = signalled ?? (result.stopReason === "cancelled" ? 130 : 1);
    if (updateCheck) {
      const upd = await updateCheck;
      if (upd?.updateAvailable) process.stderr.write(dim(`\n▲ ${updateHint(upd)}\n`));
    }
  } catch (err) {
    const message = err instanceof AmbError ? err.message : (err as Error).message;
    if (reporting === "jsonl")
      process.stdout.write(
        `${JSON.stringify({ kind: "result", sessionId, stopReason: "error", message })}\n`,
      );
    else if (machine) machine.result({ stopReason: "error", turns: 0, finalText: "" }, message);
    else process.stderr.write(`\namb: ${message}\n`);
    process.exitCode = signalled ?? 1;
  } finally {
    await fireAndForget(hooks, "SessionEnd", { reason: "exit" });
    mcp.close();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
  }
}
