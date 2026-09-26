import type { Msg } from "./ports.js";

/**
 * The conversation as sent: one system message, at the very start. Some models' chat templates (Qwen on
 * Ambient) reject a system message once the conversation has begun ("role 'system' is only supported before
 * conversation messages"), and the agent adds notes as it goes — a compaction summary, the current plan,
 * resumed context. Each later note becomes a marked note from ambient in a user turn: joined to the user
 * message it's next to, never placed between a tool call and its results.
 */
export function wireMessages(messages: readonly Msg[]): Msg[] {
  const out: Msg[] = [];
  let pending: string[] = [];
  let started = false;
  const flushAsOwnTurn = () => {
    if (pending.length === 0) return;
    out.push({ role: "user", content: pending.join("\n\n") });
    pending = [];
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (!started) {
        // One system message only: some templates reject even a second one at the start.
        const first = out[0];
        if (first?.role === "system")
          out[0] = { ...first, content: append(first.content, textOf(m.content)) };
        else out.push(m);
        continue;
      }
      const note = `<ambient-note>\n${textOf(m.content)}\n</ambient-note>`;
      const last = out[out.length - 1];
      if (last?.role === "user")
        out[out.length - 1] = { ...last, content: append(last.content, note) };
      else pending.push(note);
      continue;
    }
    started = true;
    if (m.role === "tool") {
      out.push(m); // a note waits until the call's results are all in
      continue;
    }
    if (m.role === "user" && pending.length > 0) {
      out.push({ ...m, content: prepend(pending.join("\n\n"), m.content) });
      pending = [];
      continue;
    }
    flushAsOwnTurn();
    out.push(m);
  }
  flushAsOwnTurn();
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : String(content);
}

/** A user message's content with text added after it (image parts kept in place). */
function append(content: unknown, text: string): unknown {
  if (Array.isArray(content)) return [...content, { type: "text", text }];
  const base = textOf(content);
  return base ? `${base}\n\n${text}` : text;
}

/** A user message's content with text added before it. */
function prepend(text: string, content: unknown): unknown {
  if (Array.isArray(content)) return [{ type: "text", text }, ...content];
  const base = textOf(content);
  return base ? `${text}\n\n${base}` : text;
}
