import { UNKNOWN_OUTPUT, UNKNOWN_WINDOW, budgetsFor } from "@amb/reliability";
import { estimateMessagesTokens } from "./tokens.js";

/**
 * Context compaction. Clean-room design informed by prime-agent's compaction (MIT) + Karpathy's
 * context-engineering principles: budget context like RAM, keep the recent window, summarize the
 * older middle, and NEVER lose the anchor (the original goal + constraints) so we don't "summarize
 * the summary" away the task.
 *
 * The actual summarization is done by the model; this module decides WHAT to compact and assembles
 * the structured summary skeleton + retention set. It never cuts a tool call from its result.
 */

/** The minimal message shape compaction needs. Generic over the caller's richer message type (e.g. runtime `Msg`). */
export interface CompactableMessage {
  role: string;
  content?: unknown;
  /** Marks a message that pairs a tool call with its result (kept together). */
  toolGroupId?: string;
  /** Never summarized or evicted — the current task message, wherever it sits in the conversation. */
  pinned?: boolean;
}
/** @deprecated Use {@link CompactableMessage}. Kept as an alias so external importers don't break. */
export type ChatMsg = CompactableMessage;

export interface CompactionPlan<T extends CompactableMessage = CompactableMessage> {
  /** Messages to summarize (the older middle) — same concrete type the caller passed in. */
  toSummarize: T[];
  /** Messages kept verbatim (recent window + the anchor). */
  kept: T[];
  /** The immovable part of `kept`: the leading anchor plus every pinned message, in original order. */
  anchor: T[];
  /** Index in the original array where `kept` begins. */
  keepFromIndex: number;
}

export interface CompactionConfig {
  /** Fire compaction when estimated tokens exceed contextWindow − reserveTokens. */
  reserveTokens: number;
  /** Keep at least this many tokens of the most recent messages verbatim. */
  keepRecentTokens: number;
  /** Number of leading messages that are always kept (the system prompt). The current task is kept by
   *  marking it `pinned`, so a long multi-message session never summarizes away what it's working on now. */
  anchorCount: number;
}

/** Used only when no window is known: the ModelProfile budgets for a conservative unknown model. */
const UNKNOWN_BUDGETS = budgetsFor(UNKNOWN_WINDOW, UNKNOWN_OUTPUT);
export const DEFAULT_COMPACTION: CompactionConfig = {
  reserveTokens: UNKNOWN_BUDGETS.compactReserve,
  keepRecentTokens: UNKNOWN_BUDGETS.keepRecent,
  anchorCount: 1,
};

/**
 * Scale the compaction retention to the SERVED model's window. Fixed retention/reserve numbers can't fit a
 * small (≤~32k) model: after a high→low switch the retained tokens alone exceed the usable window, so compaction can't shrink the transcript below the ceiling and the run dead-ends in
 * "blocked". Deriving both from the window lets a small model retain proportionally less and continue (lossy)
 * rather than hard-block, while a large model keeps the generous defaults (the clamps cap at the defaults).
 */
export function compactionConfigForWindow(
  contextWindow: number,
  base: CompactionConfig = DEFAULT_COMPACTION,
  outputCap: number = UNKNOWN_OUTPUT,
): CompactionConfig {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return base;
  // Both scale with the window (ModelProfile policy): a 1M-token model keeps far more recent history and
  // compacts later than a 32K one, with headroom for the next answer + a tool result.
  const b = budgetsFor(contextWindow, outputCap);
  return {
    anchorCount: base.anchorCount,
    keepRecentTokens: b.keepRecent,
    reserveTokens: b.compactReserve,
  };
}

export function shouldCompact<T extends CompactableMessage>(
  messages: T[],
  contextWindow: number,
  cfg: CompactionConfig = DEFAULT_COMPACTION,
  bytesPerToken?: number,
): boolean {
  const used = estimateMessagesTokens(messages, bytesPerToken ? { bytesPerToken } : {});
  return used > contextWindow - cfg.reserveTokens;
}

/**
 * Decide what to compact: keep the leading anchor + a recent window of ~keepRecentTokens; summarize
 * the middle. Never split a tool group (call+result stay on the same side of the cut).
 */
export function planCompaction<T extends CompactableMessage>(
  messages: T[],
  cfg: CompactionConfig = DEFAULT_COMPACTION,
  bytesPerToken?: number,
): CompactionPlan<T> {
  const anchor = messages.slice(0, cfg.anchorCount);
  const rest = messages.slice(cfg.anchorCount);
  const opts = bytesPerToken ? { bytesPerToken } : {};

  // Walk backward accumulating recent messages until we hit keepRecentTokens. Always keep AT LEAST the
  // newest message, even if it alone exceeds the budget: never summarize away the current state.
  let acc = 0;
  let cut = rest.length;
  while (cut > 0) {
    const msg = rest[cut - 1];
    if (!msg) break;
    acc += estimateMessagesTokens([msg], opts);
    const isNewest = cut === rest.length;
    if (acc > cfg.keepRecentTokens && !isNewest) break;
    cut -= 1;
  }
  // Don't split a tool group at the boundary: extend the kept region backward over the same group.
  const boundaryGroup = rest[cut]?.toolGroupId;
  if (boundaryGroup) {
    while (cut > 0 && rest[cut - 1]?.toolGroupId === boundaryGroup) cut -= 1;
  }

  // A pinned message (the current task) is never summarized, and it keeps its place in the order: moving it
  // up to the anchor would leave the previous answer as the last message, and the model would answer that
  // instead of the request.
  const toSummarize = rest.slice(0, cut).filter((m) => m.pinned !== true);
  const recent = [...rest.slice(0, cut).filter((m) => m.pinned === true), ...rest.slice(cut)];
  return {
    toSummarize,
    kept: [...anchor, ...recent],
    anchor,
    keepFromIndex: messages.length - recent.length,
  };
}

/** The fixed structured-summary skeleton the summarizer model must fill (task-tuned, not free-form). */
export const SUMMARY_SKELETON = [
  "## Goal (verbatim — never paraphrase away)",
  "## Constraints & preferences",
  "## Progress (Done / In progress / Blocked)",
  "## Key decisions (+ rationale)",
  "## Files read / modified",
  "## Test & build state",
  "## Next steps",
].join("\n");

/** Flatten a message's content to text for the summarizer — a content-parts array becomes its text parts plus
 *  an "[image]" placeholder per image, so the summary NEVER carries (or re-ships) an image's base64 bytes. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((p) => {
      if (p !== null && typeof p === "object") {
        const type = (p as { type?: unknown }).type;
        if (type === "image_url" || type === "image") return "[image]";
        const text = (p as { text?: unknown }).text;
        if (type === "text" && typeof text === "string") return text;
      }
      return JSON.stringify(p ?? "");
    })
    .join(" ");
}

/** Keep the head and tail of an over-long text so one giant message can't blow the summarizer's window. */
function clipMiddle(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  const half = Math.max(0, Math.floor((maxChars - 40) / 2));
  return `${text.slice(0, half)}\n…[${text.length - 2 * half} chars omitted]…\n${text.slice(-half)}`;
}

/** Build the summarizer request messages: prior summary (if any) + the block to compress. */
export function buildSummaryRequest(
  toSummarize: CompactableMessage[],
  priorSummary?: string,
  opts: { maxCharsPerMessage?: number; focus?: string } = {},
): { role: "system" | "user"; content: string }[] {
  const focus = opts.focus?.trim()
    ? `\n\nThe user asked this summary to focus on: ${opts.focus.trim().slice(0, 500)}. Keep everything related to that in full detail.`
    : "";
  const instruction = `Summarize the conversation below into the exact sections that follow. Preserve the original goal verbatim, every file path touched, test/build outcomes, and decisions with rationale. Be concise but lossless on those. Do not invent progress.${focus}\n\n${SUMMARY_SKELETON}`;
  const parts: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: instruction },
  ];
  if (priorSummary) parts.push({ role: "user", content: `Prior summary:\n${priorSummary}` });
  const transcript = toSummarize
    .map((m) => `${m.role}: ${clipMiddle(flattenContent(m.content), opts.maxCharsPerMessage)}`)
    .join("\n");
  parts.push({ role: "user", content: `Conversation to summarize:\n${transcript}` });
  return parts;
}

/**
 * Split messages into consecutive chunks whose summary REQUEST (instruction + prior + chunk) fits
 * `budgetTokens` — so a summarizer with a small window is never sent more than it can read. A single message
 * too big for any chunk is clipped (head + tail) by `maxCharsPerMessage` rather than dropped.
 */
export function chunkForSummary<T extends CompactableMessage>(
  messages: T[],
  budgetTokens: number,
  priorSummary: string | undefined,
  maxCharsPerMessage: number,
): T[][] {
  const fits = (chunk: T[]) =>
    estimateMessagesTokens(buildSummaryRequest(chunk, priorSummary, { maxCharsPerMessage })) <=
    budgetTokens;
  const chunks: T[][] = [];
  let cur: T[] = [];
  for (const m of messages) {
    const next = [...cur, m];
    if (cur.length > 0 && !fits(next)) {
      chunks.push(cur);
      cur = [m];
    } else {
      cur = next;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}
