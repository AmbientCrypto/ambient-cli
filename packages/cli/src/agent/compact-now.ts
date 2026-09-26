import { estimateMessagesTokens } from "@amb/context";
import type { NewEvent } from "@amb/protocol";
import { profileFor, resolveRequestedModel } from "@amb/reliability";
import {
  type CapabilityPort,
  type ChatClient,
  type HooksPort,
  type Msg,
  type WorkspaceContextPort,
  compactConversation,
} from "@amb/runtime";

export type CompactNowResult =
  | { ok: true; messages: Msg[]; before: number; after: number; model: string }
  | { ok: false; reason: string };

/** Below this, a summary would be about as long as what it replaces — not worth a model call. */
const MIN_WORTH_COMPACTING_TOKENS = 3_000;

/**
 * `/compact [focus]`: summarize the carried conversation now, sized to the model that will read it, keeping
 * only the most recent exchange verbatim. The same summarizer automatic compaction uses — so the summary
 * compounds into project memory the same way.
 */
export async function compactNow(opts: {
  client: ChatClient;
  conversation: readonly Msg[];
  /** The model the next message will go to (the one last served, or the requested one). */
  model: string;
  workspace: WorkspaceContextPort;
  workspaceRoot: string;
  sessionId: string;
  focus?: string;
  signal: AbortSignal;
  emit: (ev: NewEvent) => void;
  capabilities?: CapabilityPort;
  /** PreCompact hooks run first (trigger `manual`). */
  hooks?: HooksPort;
}): Promise<CompactNowResult> {
  if (opts.conversation.length < 3) return { ok: false, reason: "nothing to compact yet" };
  const size = estimateMessagesTokens([...opts.conversation]);
  if (size < MIN_WORTH_COMPACTING_TOKENS) {
    return {
      ok: false,
      reason: `the conversation is only ${formatTokens(size)} tokens — nothing worth compacting yet`,
    };
  }
  if (opts.hooks) {
    await opts.hooks.run(
      "PreCompact",
      { trigger: "manual", custom_instructions: opts.focus ?? "" },
      opts.signal,
    );
  }
  let catalog: Awaited<ReturnType<ChatClient["fetchCatalog"]>>;
  try {
    catalog = await opts.client.fetchCatalog(opts.signal);
  } catch {
    return { ok: false, reason: "couldn't reach Ambient to summarize — try again in a moment" };
  }
  const target = resolveRequestedModel(opts.model, catalog)?.target ?? opts.model;
  const profile = profileFor(
    target,
    catalog.find((m) => m.id === target),
    { ceiling: opts.capabilities?.learnedCeiling?.(target) },
  );
  // The anchor slot is empty here: the next run puts its own system prompt in front of the conversation.
  // Earlier runs' task messages come back marked as pinned (each was the current task in its own run);
  // here they're all history, so they're summarized in order like everything else.
  const messages: Msg[] = [
    { role: "system", content: "" },
    ...opts.conversation.map((m) => (m.pinned ? { ...m, pinned: undefined } : m)),
  ];
  const before = estimateMessagesTokens(messages);
  const next = await compactConversation(
    opts.client,
    messages,
    target,
    catalog,
    opts.sessionId,
    "trn_compact",
    opts.emit,
    opts.signal,
    (summary) => opts.workspace.writeMemory(opts.workspaceRoot, summary),
    profile.window,
    opts.workspace.readMemory(opts.workspaceRoot) ?? "",
    {
      // Keep just the latest exchange word for word; everything before it is summarized.
      keepRecentTokens: estimateMessagesTokens(lastExchange(opts.conversation)),
      ...(opts.focus?.trim() ? { focus: opts.focus.trim() } : {}),
    },
  );
  if (!next) return { ok: false, reason: "the conversation is already as small as it gets" };
  return {
    ok: true,
    messages: next.slice(1),
    before,
    after: estimateMessagesTokens(next),
    model: target,
  };
}

/** The last user message and everything after it. */
function lastExchange(conversation: readonly Msg[]): Msg[] {
  const i = conversation.findLastIndex((m) => m.role === "user");
  return i < 0 ? [] : conversation.slice(i);
}

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
