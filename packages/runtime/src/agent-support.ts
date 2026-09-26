import { createHash } from "node:crypto";
import { planCompaction } from "@amb/context";
import type { CatalogModel } from "@amb/protocol";
import { UNKNOWN_WINDOW } from "@amb/reliability";
import type { Msg } from "./ports.js";

/**
 * Pure helpers for the agent loop — no `this`, no I/O — split out to keep `agent.ts` focused on the state
 * machine. Covered by the agent + reducer test suites through their callers.
 */

/**
 * Render the model's own `plan` tool-call args into a compact anchor block. Pinning this into the
 * SYSTEM anchor each turn — which compaction never summarizes — keeps the model looking at its live checklist
 * on long autonomous runs (the #1 adherence gap: the plan otherwise scrolls into compacted history). Parsed
 * defensively + bounded here (it's advisory re-injection of the model's own list, not the durable record).
 */
export function renderPlanAnchor(args: unknown): string {
  const tasks = (args as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return "";
  const lines: string[] = [];
  for (const t of tasks.slice(0, 50)) {
    const o = t as { text?: unknown; status?: unknown };
    if (typeof o.text !== "string" || o.text.length === 0) continue;
    const mark = o.status === "done" ? "[x]" : o.status === "active" ? "[~]" : "[ ]";
    const text = o.text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (text.length > 0) lines.push(`${lines.length + 1}. ${mark} ${text}`);
  }
  return lines.length > 0
    ? `## Current plan (ADHERE to it; keep it current — mark each step done as you finish)\n${lines.join("\n")}`
    : "";
}

/**
 * The recency half of the goal "sandwich": a one-line restatement appended to the OUTBOUND messages just
 * before generation. The goal already sits at the top of the system anchor (primacy); position-bias research
 * shows weaker models still lose mid-prompt instructions, so restating it in the most-recent slot (recency)
 * keeps even an 8B model aligned. Transient — built per attempt, never persisted. Returns a NEW array (never
 * mutates the caller's messages); a no-op when there's no goal.
 */
/**
 * The model's current plan, appended to the OUTBOUND messages on every request (recency slot, like the goal
 * reminder). Kept out of the system prompt so that prompt stays byte-identical across turns — Ambient caches
 * a repeated prompt prefix, and rewriting the system prompt on every plan update would miss that cache for
 * the whole conversation. Transient; never persisted. Returns a NEW array.
 */
export function withPlanNote(messages: Msg[], planBlock: string): Msg[] {
  if (!planBlock) return messages;
  return [...messages, { role: "system", content: planBlock }];
}

export function withGoalReminder(messages: Msg[], goal: string | undefined): Msg[] {
  if (!goal || !goal.trim()) return messages;
  return [
    ...messages,
    {
      role: "system",
      content: `<goal_reminder>Your north-star goal for this session (set by the user): ${goal.trim()}. Confirm the next step serves it before acting.</goal_reminder>`,
    },
  ];
}

/**
 * Turn-budget self-pacing (recency slot, like the goal reminder): a transient system line appended to the
 * OUTBOUND messages that tells the model where it is in its turn budget so it converges instead of getting cut
 * off mid-investigation. Silent until the last ~20% of the budget (so it doesn't churn the prompt cache early);
 * on the FINAL allowed turn it becomes a hard, tool-free wrap-up so the run always ends with a consolidated
 * report + an updated plan. Transient — built per attempt, never persisted. Returns a NEW array.
 */
export function withTurnBudget(
  messages: Msg[],
  info: { turn: number; ceiling: number; finalWrapUp: boolean },
): Msg[] {
  const { turn, ceiling, finalWrapUp } = info;
  if (finalWrapUp) {
    return [
      ...messages,
      {
        role: "system",
        content:
          "<turn_budget>This is your FINAL turn — you have no tools available now. Do NOT wait for more work. Write your COMPLETE findings/answer as your reply and make sure the plan reflects what is done and what remains. This is your last message on this task.</turn_budget>",
      },
    ];
  }
  if (ceiling <= 0 || turn / ceiling < 0.8) return messages;
  const remaining = Math.max(0, ceiling - turn);
  return [
    ...messages,
    {
      role: "system",
      content: `<turn_budget>You are near your turn budget (turn ${turn} of ${ceiling}; about ${remaining} left). Stop starting new lines of investigation — consolidate what you already have, finish the step in flight, and produce your findings/answer and an updated plan before you run out.</turn_budget>`,
    },
  ];
}

/**
 * Make a carried-forward conversation SAFE to continue. The wire contract requires every assistant
 * `tool_calls` message to be answered by matching `tool` results before the next user turn. A prior run can
 * stop with a DANGLING native tool-call turn — the doom-loop guard breaks after recording the assistant call
 * but before its results, or a cancel throws mid-execution — and appending a new user message after that
 * makes the provider 400. This trims a trailing incomplete tool-call turn so the result always ends on a
 * fully-answered turn (or plain text). Only the LAST tool-calling assistant can be incomplete (the loop
 * appends a full result batch before the next generation). Assisted-lane turns record results as plain text
 * (no `toolCalls`/`toolCallId`), so they are never trimmed. Returns a copy; a no-op when already valid.
 */
/**
 * Replace image parts carried in from EARLIER messages with numbered text stubs. Images are sent once, on the
 * message they were attached to: re-sending base64 every turn wastes the window, and after a switch to a
 * blind model the stale parts would make every request 400.
 */
export function stubCarriedImages(msgs: readonly Msg[], firstNumber = 0): Msg[] {
  // A carried message is history: an earlier run's pinned task is no longer the current one.
  return stubImageParts(
    msgs.map((m) => (m.pinned ? { ...m, pinned: undefined } : m)),
    "from an earlier message — not re-sent",
    firstNumber,
  );
}

/** How many image parts are still inline in `msgs`. */
export function countImageParts(msgs: readonly Msg[]): number {
  let n = 0;
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string }>) if (p?.type === "image_url") n++;
  }
  return n;
}

/**
 * Replace every image part with a numbered text stub (`[image #N <note>]`), keeping all other fields.
 * Numbering starts after `firstNumber` so it matches the session-wide image numbers `ask_vision` uses.
 */
export function stubImageParts(msgs: readonly Msg[], note: string, firstNumber = 0): Msg[] {
  let n = firstNumber;
  return msgs.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content as Array<{ type?: string; text?: string }>;
    if (!parts.some((p) => p?.type === "image_url")) return m;
    const text = parts
      .map((p) =>
        p?.type === "image_url"
          ? `[image #${++n} ${note}]`
          : typeof p?.text === "string"
            ? p.text
            : "",
      )
      .filter((t) => t.length > 0)
      .join("\n");
    return { ...m, content: text };
  });
}

export function sanitizeContinuation(msgs: readonly Msg[]): Msg[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const answered = new Set<string>();
      for (let j = i + 1; j < msgs.length; j++) {
        const t = msgs[j];
        if (t && t.role === "tool" && typeof t.toolCallId === "string") answered.add(t.toolCallId);
      }
      const complete = m.toolCalls.every((tc) => answered.has(tc.id));
      return complete ? [...msgs] : msgs.slice(0, i);
    }
  }
  return [...msgs];
}

/**
 * Rewrite native tool turns (an assistant message carrying `tool_calls`, and its `role:"tool"` results) into
 * the ASSISTED lane's plain-text form. The assisted lane declares NO `tools` and speaks a text action-envelope,
 * so native tool structure in the history — carried in from a prior native-model run of the same session, or
 * left behind by a mid-run native→assisted failover — must not ride along: sending `tool_calls` with `tools:[]`
 * is a wire-contract mismatch strict backends 400, and it contradicts the text protocol the weak model is told
 * to use. This flattens each such message so the weak model sees the SAME information as text. Applied only to
 * the transient per-attempt request (never the stored conversation), so native runs keep native structure.
 */
export function flattenNativeToolTurns(messages: Msg[]): Msg[] {
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) nameById.set(tc.id, tc.name);
    }
  }
  return messages.map((m): Msg => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const text = typeof m.content === "string" ? m.content : "";
      const calls = m.toolCalls.map((tc) => `[called ${tc.name} ${tc.rawArgs}]`).join("\n");
      return { role: "assistant", content: [text, calls].filter(Boolean).join("\n") };
    }
    if (m.role === "tool") {
      const name = (m.toolCallId && nameById.get(m.toolCallId)) || "tool";
      const body = typeof m.content === "string" ? m.content : "";
      return { role: "user", content: `Result of ${name}:\n${body}` };
    }
    return m;
  });
}

/**
 * Plan a last-resort context SPILL: keep the goal anchor (the first 2 messages — system + goal) plus
 * the newest turn, and evict everything in between. Reuses the group-safe compaction planner so a tool call
 * and its result never land on opposite sides of the cut. Returns the serialized middle + the anchor/recent
 * pieces to reassemble the transcript, or null when there is nothing safe to evict (anchor + one turn is the
 * floor — if a single turn overflows the window, no history eviction can help and the caller honestly blocks).
 */
export function planSpill(messages: Msg[]): {
  evictedText: string;
  evictedCount: number;
  anchor: Msg[];
  recent: Msg[];
} | null {
  const plan = planCompaction(messages, { anchorCount: 1, keepRecentTokens: 1, reserveTokens: 0 });
  if (plan.toSummarize.length === 0) return null;
  // Serialize the WHOLE messages — role, content AND the native tool-call fields (toolCalls/toolCallId/
  // toolGroupId). A native assistant tool-call message carries content:"" with its real state in toolCalls, so
  // a role+content-only dump would record it as empty and the paged-back history would lose which tool ran and
  // its args. JSON preserves all of it and is legible when read back via read_artifact.
  const evictedText = JSON.stringify(plan.toSummarize, null, 2);
  return {
    evictedText,
    evictedCount: plan.toSummarize.length,
    anchor: plan.anchor,
    recent: plan.kept.slice(plan.anchor.length),
  };
}

export function catalogHash(catalog: CatalogModel[]): string {
  // Hash identity + readiness + limits + ALL capabilities (in/out modalities, features, sampling params)
  // so any capability change changes the hash.
  const shape = catalog
    .map((m) =>
      [
        m.id,
        m.isReady,
        m.contextLength,
        m.maxOutputLength,
        [...m.supportedFeatures].sort().join(","),
        [...m.inputModalities].sort().join(","),
        [...m.outputModalities].sort().join(","),
        [...m.supportedSamplingParameters].sort().join(","),
      ].join(":"),
    )
    .sort();
  return `sha256:${createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16)}`;
}

/**
 * Deterministic structured summary (no model call). Preserves the operational state that a naive
 * count-and-filenames summary drops: recent user requests, files touched, tool
 * successes/failures, and the last error — so the model won't repeat a done action or claim false success.
 */
export const SUMMARY_MARKER = "## Summary of earlier conversation";
/** Phrase unique to a spill breadcrumb (evicted history, no summary text) — distinguishes it from a summary. */
export const SPILL_NOTE = "were evicted to fit a small context window";

export function deterministicSummary(msgs: Msg[]): string {
  const files = new Set<string>();
  const userReqs: string[] = [];
  const priorSummaries: string[] = [];
  let toolOk = 0;
  let toolFail = 0;
  let lastError = "";
  for (const m of msgs) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    // Carry a PRIOR summary forward verbatim so repeated compaction doesn't erase earlier state.
    if (text.startsWith(SUMMARY_MARKER)) {
      priorSummaries.push(text);
      continue;
    }
    for (const match of text.matchAll(
      /[\w./-]+\.(ts|js|tsx|jsx|json|md|py|go|rs|txt|toml|yaml|yml)\b/g,
    ))
      files.add(match[0]);
    if (m.role === "user") userReqs.push(text.slice(0, 200));
    if (m.role === "tool") {
      if (text.startsWith("ERROR:")) {
        toolFail += 1;
        lastError = text.slice(0, 200);
      } else {
        toolOk += 1;
      }
    }
  }
  const lines = [
    `${SUMMARY_MARKER} (compacted — do not repeat completed work)`,
    `- ${msgs.length} earlier messages summarized. Tool calls this window: ${toolOk} succeeded, ${toolFail} failed.`,
    files.size > 0 ? `- Files touched/referenced: ${[...files].slice(0, 40).join(", ")}` : "",
    userReqs.length > 0 ? `- Recent requests: ${userReqs.slice(-3).join(" | ")}` : "",
    lastError ? `- Last tool error: ${lastError}` : "",
  ].filter(Boolean);
  if (priorSummaries.length > 0) {
    lines.push("- Carried forward from earlier compaction(s):");
    lines.push(
      ...priorSummaries.map((s) =>
        s
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      ),
    );
  }
  lines.push(
    "- The current task is the pinned user message above. Continue from the recent messages below; verify before claiming success.",
  );
  return lines.join("\n");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
}

/**
 * Cap a single tool result so one huge output can't overflow the model window on its own. `maxBytes` is
 * CEILING-AWARE (from `toolResultCharBudget`) so it tightens as the window fills; keeps a head + tail with an
 * honest truncation marker in the middle. Measured in UTF-8 BYTES (not UTF-16 `.length`) so multi-byte text
 * (CJK/emoji) is budgeted like the tokenizer sees it, not 3× over. The marker is reserved INSIDE the cap.
 */
export const MAX_TOOL_RESULT_CHARS = 24_000;
const MARKER_RESERVE_BYTES = 48; // room for "\n…[NNNNNNNN bytes truncated]…\n"
export function capToolResult(text: string, maxBytes: number = MAX_TOOL_RESULT_CHARS): string {
  const cap = Number.isFinite(maxBytes)
    ? Math.max(200, Math.floor(maxBytes))
    : MAX_TOOL_RESULT_CHARS;
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  if (bytes.length <= cap) return text;
  const budget = Math.max(0, cap - MARKER_RESERVE_BYTES);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  const omitted = bytes.length - head - tail;
  // A byte-slice may split a trailing multi-byte code point → TextDecoder replaces it with U+FFFD (harmless
  // in a truncated preview). Omitted count is computed from the ACTUAL retained bytes.
  const dec = new TextDecoder();
  return `${dec.decode(bytes.slice(0, head))}\n…[${omitted} bytes truncated]…\n${dec.decode(bytes.slice(bytes.length - tail))}`;
}

export function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return "[unserializable result]";
  }
}

/** True if a tool result carries a durable file mutation (write/edit/apply_patch) — drives the verify gate. */
export function isMutationOutcome(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const op = (result as { operation?: unknown }).operation;
  if (op === "create" || op === "modify" || op === "delete") return true;
  // apply_patch returns { files: [{operation}], ... } rather than a single operation.
  const files = (result as { files?: unknown }).files;
  return (
    Array.isArray(files) &&
    files.some(
      (f) =>
        f &&
        typeof f === "object" &&
        ["create", "modify", "delete"].includes((f as { operation?: string }).operation ?? ""),
    )
  );
}

/** A conservative stand-in when a target model isn't in the live catalog (budgeting must never crash). */
export function fallbackModel(id: string): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: [],
    supportedSamplingParameters: [],
    contextLength: UNKNOWN_WINDOW, // unknown model → conservative (same default as ModelProfile)
    maxOutputLength: 8192,
  };
}
