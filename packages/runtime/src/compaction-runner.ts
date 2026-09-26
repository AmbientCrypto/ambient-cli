import {
  buildSummaryRequest,
  chunkForSummary,
  compactionConfigForWindow,
  estimateMessagesTokens,
  planCompaction,
} from "@amb/context";
import type { CatalogModel } from "@amb/protocol";
import {
  SAFE_MAX_OUTPUT_TOKENS,
  UNKNOWN_OUTPUT,
  UNKNOWN_WINDOW,
  pickForRole,
  sameModel,
  streamTimeouts,
} from "@amb/reliability";
import { SPILL_NOTE, SUMMARY_MARKER, deterministicSummary, planSpill } from "./agent-support.js";
import { MAX_COMPACTIONS } from "./constants.js";
import { summaryEffort } from "./effort.js";
import type { ChatClient, Msg, RunOptions } from "./ports.js";
import { wireMessages } from "./wire-messages.js";

/**
 * Context-management for the agent loop — split out of `agent.ts` so the state machine stays focused. These
 * are the two ways the loop reclaims window space (model-summary compaction, then a lossy artifact spill) plus
 * the `reduceContext` that combines them. Pure w.r.t. their message input (return a NEW array or null; never
 * mutate in place). `client` is injected so this module has no `this` and is directly testable.
 */

/**
 * Compact the conversation. Prefers a MODEL-written structured summary (goal-anchored, lossless on
 * files/decisions/test-state — the SUMMARY_SKELETON) and falls back to the deterministic offline summary
 * if the model call fails/aborts. The anchor (system + the original goal) is NEVER summarized, so the goal
 * survives every compaction. Persists the structured summary to `.ambient/MEMORY.md` (compounding memory).
 * PURE w.r.t. its input: returns a NEW message array on real progress (fewer tokens), or `null` when there
 * is nothing to compact / no reduction — never mutates `messages` in place (immutability rule).
 */
export async function compact(
  client: ChatClient,
  messages: Msg[],
  target: string,
  catalog: CatalogModel[],
  sessionId: string,
  turnId: string,
  emit: RunOptions["emit"],
  signal: AbortSignal,
  persistMemory: (summary: string) => void,
  windowTokens: number,
  priorMemory: string,
  /** `/compact`: keep less recent history than automatic compaction would, and focus the summary. */
  opts: { keepRecentTokens?: number; focus?: string } = {},
): Promise<Msg[] | null> {
  // Retention scaled to the SERVED model's window — a small model keeps proportionally less so the
  // transcript can actually shrink below its ceiling (a fixed 20k-recent floor can't fit a ≤32k model). The
  // window is the caller's LEARNED-ceiling-aware budget: using the raw catalog window here
  // while the trigger used the learned window made compaction retain too much and re-overflow → "blocked".
  const served = catalog.find((m) => m.id === target);
  const auto = compactionConfigForWindow(
    windowTokens,
    undefined,
    Math.min(served?.maxOutputLength ?? UNKNOWN_OUTPUT, windowTokens),
  );
  const cfg =
    opts.keepRecentTokens !== undefined
      ? { ...auto, keepRecentTokens: Math.min(auto.keepRecentTokens, opts.keepRecentTokens) }
      : auto;
  const before = estimateMessagesTokens(messages);
  const plan = planCompaction(messages, cfg);
  if (plan.toSummarize.length === 0) return null;

  // A model summary preserves plan/decisions/rationale that the deterministic one drops; on any failure
  // (rate-limit, transport, abort) we fall back to the deterministic summary so compaction never blocks.
  const facts = deterministicSummary(plan.toSummarize);
  const factsBody = facts.replace(/^## [^\n]*\n?/, "").trim(); // drop its own marker header
  let summary = facts;
  if (!signal.aborted) {
    // Fleet-routed compaction: summarization is a mechanical utility task, so route it to a CHEAP
    // model from the live fleet instead of burning the run's (often flagship/coding) `target` — a real
    // per-token cost win on a pay-per-token network. Falls back to `target` if nothing cheaper is warm, and
    // the whole call falls back to the deterministic summary on any failure, so a cold cheap model is safe.
    const picked = pickForRole("compactor", catalog) ?? target;
    // An alias of the model already serving you is the same model — no handoff to announce.
    const compactor = sameModel(catalog, picked, target) ? target : picked;
    if (compactor !== target) {
      emit({
        schemaVersion: 1,
        kind: "handoff",
        sessionId,
        turnId,
        from: target,
        to: compactor,
        role: "compactor",
        reason: "cheap-model compaction",
      });
    }
    // Feed the PRIOR project memory as the prior-summary so the new summary COMPOUNDS it instead of
    // replacing it (memory lives in the anchor, excluded from toSummarize, so without this the next
    // session's first compaction would erase it).
    const narrative = await rollingSummary(
      client,
      catalog.find((m) => m.id === compactor),
      compactor,
      plan.toSummarize,
      priorMemory || undefined,
      windowTokens,
      signal,
      compactor === target,
      opts.focus,
    );
    // Use the model's NARRATIVE but ALWAYS append the AUTHORITATIVE facts from the log (files touched, tool
    // ok/fail, last error) so a weak compactor can't fabricate "all tests pass" or drop real errors and then
    // steer the strong model wrong.
    if (narrative) {
      summary =
        factsBody.length > 0
          ? `${narrative}\n\n## Ground truth (from the session log — authoritative; trust over the narrative above)\n${factsBody}`
          : narrative;
    }
  }

  // Cancelled: change nothing — no rewritten memory, no summary swapped in.
  if (signal.aborted) return null;

  const anchor = plan.anchor; // the system prompt (the pinned current task stays in place in `recent`)
  const recent = plan.kept.slice(anchor.length);
  const summaryMsg: Msg = {
    role: "system",
    // MUST start with SUMMARY_MARKER (the SAME constant the deterministic path reads) so a LATER compaction
    // carries this summary forward verbatim instead of dropping it — otherwise repeated compaction
    // progressively loses earlier state (the exact drift compaction is meant to prevent).
    // The RE-ORIENTATION footer tells the model how to recalibrate cleanly after a compaction: the older turns
    // are now this summary, so lean on the pinned plan (kept in the system anchor, never summarized) + this
    // summary to resume from the right place — keep the plan current and continue the next unfinished step
    // instead of redoing completed work. (Appended to the message only, NOT to the persisted project memory.)
    content: `${SUMMARY_MARKER} (another model may have written this — re-verify with your tools before relying on it)\n${summary}\n\n→ The turns above were just summarized to save context. Re-read your pinned plan and this summary, update the plan with the \`plan\` tool (mark finished steps done), then CONTINUE FROM THE NEXT UNFINISHED STEP — do not repeat work already completed.`,
  };
  const next: Msg[] = [...anchor, summaryMsg, ...recent];
  const after = estimateMessagesTokens(next);
  if (after >= before) return null; // no real reduction — don't loop

  persistMemory(summary); // compounding project memory (best-effort, via the workspace port)
  emit({
    schemaVersion: 1,
    kind: "context.compacted",
    sessionId,
    turnId,
    keptTokens: after,
    summarizedPhases: plan.toSummarize.length,
  });
  return next;
}

/** Most summarizer calls one compaction may spend; older overflow is folded in deterministically instead. */
const MAX_SUMMARY_CHUNKS = 8;

/** Summary output budget: the COMPACTOR's own output cap, at most 15% of its window (room for the input) and
 *  of the READER's window (the summary has to fit where it lands). */
export function summaryOutputTokens(
  model: CatalogModel | undefined,
  window: number,
  readerWindow: number = window,
): number {
  const cap = Math.min(model?.maxOutputLength ?? UNKNOWN_OUTPUT, SAFE_MAX_OUTPUT_TOKENS);
  return Math.max(1024, Math.min(cap, Math.floor(window * 0.15), Math.floor(readerWindow * 0.15)));
}

/**
 * Summarize `toSummarize` with the compactor, sized to the compactor's OWN window: a middle bigger than that
 * window is split into chunks and summarized as a rolling refine (each call gets the previous summary as its
 * prior). Returns the narrative, or undefined on any failure/truncation (the caller keeps the deterministic
 * summary — compaction never blocks on the model).
 */
async function rollingSummary(
  client: ChatClient,
  model: CatalogModel | undefined,
  compactor: string,
  toSummarize: Msg[],
  prior: string | undefined,
  fallbackWindow: number,
  signal: AbortSignal,
  sameAsTarget: boolean,
  focus?: string,
): Promise<string | undefined> {
  // When the compactor IS the served model, the caller's window already includes its learned ceiling; a
  // different compactor uses its own catalog window, or a conservative default when it doesn't publish one.
  const window = sameAsTarget ? fallbackWindow : (model?.contextLength ?? UNKNOWN_WINDOW);
  const maxTokens = summaryOutputTokens(model, window, fallbackWindow);
  const inputBudget = Math.floor(window * 0.9) - maxTokens;
  if (inputBudget < 1024) return undefined;
  // The prior summary may take at most a quarter of the input; per-message clipping keeps any single giant
  // tool output from monopolizing a chunk.
  const clipPrior = (p: string | undefined) =>
    p && p.length > inputBudget ? `${p.slice(0, inputBudget)}\n…[earlier summary clipped]` : p;
  const maxCharsPerMessage = Math.floor(inputBudget * 1.5);
  let chunks = chunkForSummary(toSummarize, inputBudget, clipPrior(prior), maxCharsPerMessage);
  let rolling = clipPrior(prior);
  if (chunks.length > MAX_SUMMARY_CHUNKS) {
    const overflow = chunks.slice(0, chunks.length - MAX_SUMMARY_CHUNKS).flat();
    rolling = clipPrior(
      [rolling, deterministicSummary(overflow)].filter((x): x is string => Boolean(x)).join("\n\n"),
    );
    chunks = chunks.slice(-MAX_SUMMARY_CHUNKS);
  }
  for (const chunk of chunks) {
    if (signal.aborted) return undefined;
    const req = buildSummaryRequest(chunk, rolling, {
      maxCharsPerMessage,
      ...(focus ? { focus } : {}),
    });
    try {
      const out = await client.chat({
        model: compactor,
        messages: wireMessages(req),
        tools: [],
        maxTokens,
        // Utility task — cheap by design; never spends the run's high-effort tokens summarizing.
        reasoningEffort: summaryEffort(model),
        timeouts: streamTimeouts({ promptTokens: estimateMessagesTokens(req) }),
        signal,
      });
      const text = out.content.trim();
      // A TRUNCATED summary (hit the output cap) is untrusted → the caller keeps the deterministic one.
      if (text.length === 0 || out.finishReason === "length") return undefined;
      rolling = clipPrior(text);
    } catch {
      return undefined;
    }
  }
  return rolling;
}

/**
 * Last-resort context relief: when compaction can't shrink the transcript below the served window,
 * EVICT the middle (everything between the goal anchor and the newest turn) to the artifact store and leave
 * a breadcrumb the model can page back in via read_artifact. Needs NO model call, so it always shrinks and
 * works even when the compactor is cold — the honest answer to "run on ANY model, Qwen → GLM-5.2". Tool
 * groups are never split (reuses planSpill). Returns the smaller array, or null when there's nothing
 * safe left to evict (the goal anchor + one turn is the floor — if a single turn overflows, we honestly block).
 */
export function spillToArtifact(
  messages: Msg[],
  sessionId: string,
  turnId: string,
  emit: RunOptions["emit"],
  artifact?: (content: string) => string | undefined,
): Msg[] | null {
  if (!artifact) return null;
  // planSpill keeps the goal anchor + the newest turn (group-safe: a tool call and its result never split)
  // and serializes the middle for eviction, or returns null when there's nothing safe left to evict.
  const spill = planSpill(messages);
  if (!spill) return null;
  const handle = artifact(spill.evictedText);
  if (!handle) return null;
  // The breadcrumb MUST start with SUMMARY_MARKER so a LATER compaction carries the handle forward verbatim
  // (deterministicSummary preserves prior-summary lines) instead of paraphrasing the pointer away.
  const breadcrumb: Msg = {
    role: "system",
    content: `${SUMMARY_MARKER} — ${spill.evictedCount} earlier message(s) ${SPILL_NOTE}. They are not lost: call read_artifact({handle:"${handle}"}) to page through that history if you need it.`,
  };
  const next: Msg[] = [...spill.anchor, breadcrumb, ...spill.recent];
  if (estimateMessagesTokens(next) >= estimateMessagesTokens(messages)) return null; // no real reduction
  emit({
    schemaVersion: 1,
    kind: "context.compacted",
    sessionId,
    turnId,
    keptTokens: estimateMessagesTokens(next),
    summarizedPhases: spill.evictedCount,
  });
  return next;
}

/**
 * Reclaim context to fit the served window: normal model-summary compaction first; if that can't
 * shrink further (hit the compaction cap, or nothing left to summarize), fall back to a lossy artifact
 * SPILL of the middle so a small-window / weak model keeps MOVING instead of dead-ending in "blocked".
 * Returns the smaller transcript, or null when nothing more can be reclaimed (the caller then blocks).
 */
export async function reduceContext(
  client: ChatClient,
  messages: Msg[],
  target: string,
  catalog: CatalogModel[],
  sessionId: string,
  turnId: string,
  emit: RunOptions["emit"],
  signal: AbortSignal,
  persistMemory: (summary: string) => void,
  windowTokens: number,
  priorMemory: string,
  compactions: number,
  artifact?: (content: string) => string | undefined,
): Promise<Msg[] | null> {
  const compacted =
    compactions >= MAX_COMPACTIONS
      ? null
      : await compact(
          client,
          messages,
          target,
          catalog,
          sessionId,
          turnId,
          emit,
          signal,
          persistMemory,
          windowTokens,
          priorMemory,
        );
  if (compacted) return compacted;
  return spillToArtifact(messages, sessionId, turnId, emit, artifact);
}
