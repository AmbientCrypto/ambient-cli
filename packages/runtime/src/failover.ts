import { budgetFromCatalog, estimateMessagesTokens, estimateTokens, preflight } from "@amb/context";
import {
  AmbError,
  type CatalogModel,
  type Lane,
  newAttemptId,
  supportsVision,
} from "@amb/protocol";
import {
  backoffSeconds,
  budgetsFor,
  nextMaxTokens,
  readySubstitute,
  streamTimeouts,
} from "@amb/reliability";
import { fallbackModel, isAbortError } from "./agent-support.js";
import { AssistedDeltaFilter } from "./assisted.js";
import { MAX_FAILOVERS, MAX_SAME_MODEL_RETRIES } from "./constants.js";
import type {
  CapabilityPort,
  ChatClient,
  ChatParams,
  ReasoningLevel,
  RunOptions,
  TurnCompletion,
} from "./ports.js";
import { wireMessages } from "./wire-messages.js";

/** How often (in tokens) held-back output is reported while a tool call is being written. */
const HIDDEN_REPORT_EVERY = 16;

/** The seams the failover loop needs from the Agent — the transport, a backoff sleep, and the lane oracle. */
export interface FailoverDeps {
  client: ChatClient;
  sleep: (seconds: number) => Promise<void>;
  laneOf: (modelId: string, catalog: CatalogModel[], capabilities?: CapabilityPort) => Lane;
}

/** Per-attempt context: identity, streaming, the request's lane, effort resolution, and catalog/model callbacks. */
export interface FailoverCtx {
  sessionId: string;
  turnId: string;
  attemptId: string;
  emit: RunOptions["emit"];
  signal: AbortSignal;
  streamDeltas?: boolean;
  /** The transport lane the request was built with — a failover substitute must match it. */
  lane: Lane;
  /** The outbound message carries image content-parts — a failover substitute MUST be vision-capable, else it
   *  would 400 on parts it can't read. Prefer + hard-require a vision model when set. */
  hasImage?: boolean;
  /** Accurate per-image token cost for this run's plan, so the per-attempt preflight sizes images correctly
   *  (not the flat default). Undefined ⇒ the estimator's conservative default. */
  imageTokens?: (part: unknown) => number;
  capabilities?: CapabilityPort;
  /** Resolve the reasoning effort to send for a given served model (re-resolved per attempt). */
  effortFor: (model: CatalogModel | undefined) => ReasoningLevel | undefined;
  onCatalog: (c: CatalogModel[]) => void;
  onSwitch: (m: string) => void;
}

/**
 * One logical inference for the turn, with bounded per-attempt failover. Each ACTUAL request (initial,
 * escalated, or failed-over) is logged as its own inference.request/response with the model it hit and
 * that model's own budget. Rate-limits back off and RETRY THE SAME MODEL a couple times
 * before failing over; cold/persistent-rate-limit fails over, avoiding already-failed models
 * with backoff. Honors abort. Streams deltas per attempt.
 */
/** Sleep that wakes EARLY on abort — otherwise a Ctrl-C during a long (up to ~30s) backoff is ignored until
 *  the timer fires. Races the injected sleep against the abort signal, cleaning up its listener either way. */
async function abortableSleep(
  sleep: (seconds: number) => Promise<void>,
  seconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(seconds), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Longest honored server `Retry-After`, so a hostile/buggy header can't park the run for hours. */
const RETRY_AFTER_CAP_S = 60;

/** Backoff for a retry: our jittered exponential, raised to the server's `Retry-After` when it asks for more. */
export function retryDelaySeconds(err: AmbError, attempt: number): number {
  const ours = backoffSeconds(attempt);
  if (err.retryAfterMs === undefined) return ours;
  return Math.max(ours, Math.min(RETRY_AFTER_CAP_S, err.retryAfterMs / 1000));
}

export async function runChatWithFailover(
  deps: FailoverDeps,
  params: ChatParams,
  startModel: string,
  failed: Set<string>,
  catalog: CatalogModel[],
  escalation: number,
  ctx: FailoverCtx,
): Promise<{ result: TurnCompletion; attemptId: string }> {
  let current = startModel;
  let live = catalog;
  let sameModelRetries = 0;
  let failovers = 0;
  for (let attempt = 0; ; attempt++) {
    // A fresh attempt id per ACTUAL request so streamed deltas never blend across models.
    const attemptId = attempt === 0 ? ctx.attemptId : newAttemptId();
    const model = live.find((m) => m.id === current);
    const budget = budgetFromCatalog(
      model ?? fallbackModel(current),
      ctx.capabilities?.learnedCeiling?.(current),
    );
    const promptTokens =
      estimateMessagesTokens(
        params.messages,
        ctx.imageTokens ? { imageTokens: ctx.imageTokens } : {},
      ) + estimateTokens(JSON.stringify(params.tools));
    // Each model (including a failover) asks for its OWN output budget, derived from its catalog entry.
    const pf = preflight(budget, {
      promptEstimate: promptTokens,
      requestedOutput: budgetsFor(budget.contextWindow, budget.outputCap).desiredOutput,
      reasoning: true,
    });
    if (pf.overflow)
      throw new AmbError({
        kind: "overflow",
        message: "prompt exceeds the model window",
        retryable: true,
        model: current,
      });
    // Escalation must never exceed the model's own output cap.
    const sentOutput =
      escalation > 0
        ? Math.min(
            nextMaxTokens(pf.sentOutput, { window: budget.contextWindow, promptTokens }),
            budget.outputCap,
          )
        : pf.sentOutput;

    // Re-resolved per attempt: a failover to a non-reasoning model drops the param automatically. Captured
    // once so the same value drives the request, its announcement, and the inference.response readout.
    const reqEffort = ctx.effortFor(model);
    ctx.emit({
      schemaVersion: 1,
      kind: "inference.request",
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      attemptId,
      targetModel: current,
      sentOutput,
      promptTokens,
      escalation,
      ...(reqEffort ? { effort: reqEffort } : {}),
    });
    const attemptStarted = Date.now();
    try {
      const stream = ctx.streamDeltas !== false;
      // The assisted lane's reply carries action envelopes: stream only the prose around them.
      const filter = ctx.lane === "assisted" ? new AssistedDeltaFilter() : undefined;
      let hidden = 0;
      const result = await deps.client.chat({
        ...params,
        // System messages only at the start — some models reject one mid-conversation (wire-messages.ts).
        messages: wireMessages(params.messages),
        model: current,
        maxTokens: sentOutput,
        reasoningEffort: reqEffort,
        // Bound the stream: a worker that accepts the request then goes silent must not hang the turn.
        timeouts: streamTimeouts({
          promptTokens,
          ...(reqEffort ? { effort: reqEffort } : {}),
          flaggedCold: model?.isReady === false,
        }),
        onContent: stream
          ? (t) => {
              const text = filter ? filter.push(t) : t;
              if (text.length === 0) return;
              ctx.emit({
                schemaVersion: 1,
                kind: "assistant.delta",
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                attemptId,
                text,
              });
            }
          : undefined,
        onReasoning: stream
          ? (t) =>
              ctx.emit({
                schemaVersion: 1,
                kind: "reasoning.delta",
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                attemptId,
                text: t,
              })
          : undefined,
        // A tool call taking shape: say what the agent is about to do before the arguments finish streaming.
        onToolDraft: stream
          ? (d) =>
              ctx.emit({
                schemaVersion: 1,
                kind: "tool.drafting",
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                attemptId,
                toolName: d.name,
                ...(d.path ? { path: d.path } : {}),
              })
          : undefined,
        // The server holds a tool call back until it's complete: count what's being produced so the user sees
        // progress rather than a stalled "Thinking" (reported every few tokens, not every one).
        onHiddenOutput: stream
          ? () => {
              hidden += 1;
              if (hidden === 1 || hidden % HIDDEN_REPORT_EVERY === 0)
                ctx.emit({
                  schemaVersion: 1,
                  kind: "tool.drafting",
                  sessionId: ctx.sessionId,
                  turnId: ctx.turnId,
                  attemptId,
                  tokens: hidden,
                });
            }
          : undefined,
      });
      // Whatever the assisted-lane filter was still holding (a closing code fence) belongs to the answer.
      const tail = filter?.flush() ?? "";
      if (stream && tail.length > 0)
        ctx.emit({
          schemaVersion: 1,
          kind: "assistant.delta",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          attemptId,
          text: tail,
        });
      const empty = result.content.trim().length === 0 && result.toolCalls.length === 0;
      ctx.capabilities?.recordOutcome?.(current, !empty, Date.now() - attemptStarted);
      ctx.emit({
        schemaVersion: 1,
        kind: "inference.response",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        attemptId,
        ...(result.reportedModel ? { reportedModel: result.reportedModel } : {}),
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(result.usage?.promptTokens !== undefined
          ? { promptTokens: result.usage.promptTokens }
          : {}),
        ...(result.usage?.completionTokens !== undefined
          ? { completionTokens: result.usage.completionTokens }
          : {}),
        ...(result.usage?.cachedTokens !== undefined
          ? { cachedTokens: result.usage.cachedTokens }
          : {}),
        ...(reqEffort ? { effort: reqEffort } : {}),
        empty,
        truncated: result.finishReason === "length",
      });
      return { result, attemptId };
    } catch (rawErr) {
      if (ctx.signal.aborted)
        throw new AmbError({ kind: "cancelled", message: "cancelled", retryable: false });
      // A mid-stream / network failure (dropped SSE, ECONNRESET, socket hang up) arrives from the streaming
      // client as a PLAIN Error — classify it as a RETRYABLE transport error so it FAILS OVER to a warm
      // worker instead of crashing the whole run. (The retryable flag was previously dead: only cold and
      // rate_limit ever failed over, so an upstream 5xx or a dropped stream killed the turn.)
      const err =
        rawErr instanceof AmbError
          ? rawErr
          : new AmbError({
              kind: "transport",
              message: rawErr instanceof Error ? rawErr.message : String(rawErr),
              retryable: true,
              model: current,
            });
      // A model that stalled, was unreachable or had no workers counts against it when choosing a default
      // later; our own mistakes (auth, a bad request, an overflow) do not.
      if (err.kind === "transport" || err.kind === "cold" || err.kind === "rate_limit") {
        ctx.capabilities?.recordOutcome?.(current, false, Date.now() - attemptStarted);
      }
      // Record the failed attempt so the log isn't a request with no response (fidelity).
      ctx.emit({
        schemaVersion: 1,
        kind: "error",
        sessionId: ctx.sessionId,
        message: err.message,
        errorKind: err.kind,
        ...(err.model ? { model: err.model } : {}),
      });

      // Transient on a decentralized fleet: rate_limit, cold, OR a retryable transport blip (5xx/drop).
      // Anything else (auth, overflow, a non-retryable 4xx) is terminal.
      const transient =
        err.kind === "cold" ||
        err.kind === "rate_limit" ||
        (err.kind === "transport" && err.retryable);
      if (!transient) throw err;

      // Back off and RETRY THE SAME worker first for rate-limits AND transient transport blips (a cold
      // worker has none, so it fails over immediately).
      // A STALLED worker gets one same-model retry (the gateway may route to another worker), not two — each
      // stall already cost a full timeout.
      const sameModelLimit = err.detail === "stream-stall" ? 1 : MAX_SAME_MODEL_RETRIES;
      if (err.kind !== "cold" && sameModelRetries < sameModelLimit) {
        sameModelRetries += 1;
        await abortableSleep(deps.sleep, retryDelaySeconds(err, sameModelRetries), ctx.signal);
        continue;
      }
      // Bound the number of FAILOVERS independently of same-model retries. On exhaustion, surface a CLEAR
      // terminal message — not the last per-attempt "…trying another" (which reads as if a retry is still
      // coming) and points at one model when the real cause (e.g. every model 404s) may be endpoint/config.
      if (failovers >= MAX_FAILOVERS) {
        throw new AmbError({
          kind: err.kind,
          message: `all ${failovers + 1} model attempts failed (last: ${err.message}) — check your Ambient endpoint/API key with \`ambient doctor\``,
          retryable: false,
          ...(err.model ? { model: err.model } : {}),
        });
      }
      failovers += 1;
      // Retry-After is about THIS model; switching to another one only needs our normal backoff.
      if (err.kind !== "cold")
        await abortableSleep(deps.sleep, backoffSeconds(failovers), ctx.signal);

      // Fail over to a warm model, never one we've already failed on this turn.
      failed.add(current);
      try {
        live = await deps.client.fetchCatalog(ctx.signal, { fresh: true });
      } catch (fe) {
        // A cancelled failover catalog refresh is a cancellation, not an error.
        if (ctx.signal.aborted || isAbortError(fe))
          throw new AmbError({ kind: "cancelled", message: "cancelled", retryable: false });
        throw err;
      }
      ctx.onCatalog(live);
      const masked = live;
      // Prefer a substitute whose transport lane MATCHES the request we already built: a direct-lane
      // request has native `tools` on the wire, so a native-incapable (assisted-only) substitute would
      // silently ignore them and reply with prose. Fall back to any warm model if none match the lane.
      const visionOk = (id: string): boolean =>
        !ctx.hasImage || supportsVision(masked.find((m) => m.id === id) ?? { inputModalities: [] });
      const next = readySubstitute(current, masked, {
        // A substitute must match the request's lane AND (when the message carries images) be vision-capable.
        prefer: (id) => deps.laneOf(id, masked, ctx.capabilities) === ctx.lane && visionOk(id),
        // Never retry a model that already failed this turn; if the catalog flags everything cold, still
        // try the rest (the flag is a hint — a real "no workers" 429 fails over again).
        exclude: failed,
        attemptCold: true,
      });
      if (!next || failed.has(next)) throw err;
      // Vision SAFETY: never ship image parts to a blind model (it 400s). If no warm vision-capable substitute
      // exists, fail honestly rather than mis-serve — the agent surfaces the error; the relay is a pre-run path.
      if (!visionOk(next)) throw err;
      // Lane SAFETY (not just preference): a DIRECT request already put native `tools` on the wire, so
      // failing over to an ASSISTED-only model would send tools it ignores and silently "succeed" with no
      // work done. Only `assisted` is unsafe — the request-build classifies `assisted` as the text lane and
      // EVERYTHING ELSE (`direct` AND `unknown`) as the native transport, so mirror that exactly (an
      // over-broad `!== "direct"` would wrongly block a warm `unknown` substitute). If none is safe, fail
      // honestly rather than mis-serve; an ASSISTED request's protocol lives in the prompt and works on any
      // model, so it needs no guard (a fresh retry re-resolves `next` into the assisted lane from the start).
      if (ctx.lane === "direct" && deps.laneOf(next, masked, ctx.capabilities) === "assisted")
        throw err;

      ctx.emit({
        schemaVersion: 1,
        kind: "handoff",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        from: current,
        to: next,
        role: "executor",
        lane: ctx.lane,
        reason: `${current} is ${err.kind === "transport" ? "unreachable" : err.kind}; failing over to a warm model`,
      });
      ctx.onSwitch(next);
      current = next;
      sameModelRetries = 0;
    }
  }
}
