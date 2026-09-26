import type { ToolDefinition } from "@amb/protocol";
import { toJSONSchema } from "@amb/protocol";

/**
 * The controller-ASSISTED lane. Some Ambient models don't reliably emit native OpenAI tool calls. For
 * them we don't send a `tools` array; instead we describe the tools as TEXT in the system prompt and ask
 * the model to answer with a single fenced action envelope. We parse + deterministically validate that
 * envelope (the "controller"), execute it through the normal tool path, and feed the result back as text.
 * This is how `amb` works with EVERY serveable model, not only the tool-native ones.
 */

export const ACTION_FENCE = "amb-action";

/**
 * Render the tool set as text for the system prompt. COMPACT by design: a signature line per tool
 * (`name(p1:type, p2?:type): description`, `?` = optional) instead of each tool's full nested JSON Schema —
 * the schema blob is several K tokens per turn on EVERY assisted request, on exactly the small-window models
 * least able to afford it. The signature carries the param names/types/required the model needs to form a
 * call; the tool's own description covers the rest.
 */
export function renderToolsAsText(tools: ToolDefinition[]): string {
  return tools
    .map((t) => {
      const schema = toJSONSchema(t.inputSchema as never) as {
        properties?: Record<string, { type?: unknown }>;
        required?: unknown;
      };
      const props = schema.properties ?? {};
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const params = Object.entries(props)
        .map(([k, v]) => {
          const type = typeof v?.type === "string" ? v.type : "any";
          return `${k}${required.has(k) ? "" : "?"}:${type}`;
        })
        .join(", ");
      return `- ${t.manifest.name}(${params}): ${t.manifest.description}`;
    })
    .join("\n");
}

/** The protocol instructions appended to the system prompt in assisted mode. */
export function assistedProtocol(tools: ToolDefinition[]): string {
  return [
    "You do not have native tool-calling. To use a tool, reply with a fenced block:",
    "",
    `\`\`\`${ACTION_FENCE}`,
    '{"tool": "<tool-name>", "args": { ... }}',
    "```",
    "",
    "Rules:",
    `- You may emit up to ${MAX_ACTIONS} action blocks in one reply when the calls don't depend on each other (reading several files, say); they run in order. Put NOTHING after the last block.`,
    "- `args` must be a JSON object matching that tool's parameters.",
    "- When the task is finished, reply with a plain-text final answer and NO action block.",
    "",
    "Available tools:",
    renderToolsAsText(tools),
  ].join("\n");
}

/** True when the ENTIRE trimmed reply is a JSON object shaped like an ACTION envelope — a string `tool` AND
 *  an `args` object (our protocol's exact shape). Requiring `args` avoids misclassifying a legitimate final
 *  JSON answer that merely happens to have a `tool` key (e.g. `{"tool":"hammer","version":1}`) as an action,
 * which would otherwise loop to maxTurns. Only matches a pure object, never executes it. */
function looksLikeBareAction(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  try {
    const o = JSON.parse(t) as { tool?: unknown; args?: unknown };
    if (typeof o !== "object" || o === null) return false;
    if (typeof o.tool !== "string" || o.tool.length === 0) return false;
    return typeof o.args === "object" && o.args !== null && !Array.isArray(o.args);
  } catch {
    return false;
  }
}

/** Most action blocks acted on from one reply. */
export const MAX_ACTIONS = 8;

export interface AssistedAction {
  tool: string;
  args: unknown;
  rawArgs: string;
}

export type AssistedParse =
  | { kind: "action"; actions: AssistedAction[] }
  | { kind: "final"; text: string }
  | { kind: "error"; message: string; text: string };

// Accept BOTH the multi-line fence (```amb-action\n{…}\n```) AND a single-line one (```amb-action {…}``` /
// ```amb-action{…}```) — some weak models emit the whole envelope on one line, and requiring a newline meant
// that reply was NEITHER parsed (the tool call was dropped → repair-nudge loop) NOR stripped (raw protocol
// JSON shown to the user). `(?![A-Za-z0-9_])` keeps `amb-actionable`/extended info strings from matching; the
// non-greedy capture still runs to the closing ``` so nested JSON objects are captured whole.
const FENCE_BODY = "(?![A-Za-z0-9_])\\s*([\\s\\S]*?)```";
const FENCE_RE = new RegExp(`\`\`\`${ACTION_FENCE}${FENCE_BODY}`, "i");
const FENCE_RE_G = new RegExp(`\`\`\`${ACTION_FENCE}${FENCE_BODY}`, "gi");
// An UNTERMINATED open fence (a line-start ```amb-action … EOF, no closing ```) — stripped so a malformed
// envelope never surfaces as a user-facing final answer. The info string must be EXACTLY `amb-action`
// (only horizontal whitespace may follow it, then newline/EOF) at a line start indented ≤3 spaces — the
// same fence shape Markdown + the complete-fence matcher accept. This can't match inline prose, can't match
// a prefix like ```amb-actionable or an extended info string ```amb-action example, and can't reach into
// legitimate text that follows an already-removed complete fence.
const OPEN_FENCE_RE = new RegExp(`(^|\\n) {0,3}\`\`\`${ACTION_FENCE}[ \\t]*(\\n|$)[\\s\\S]*$`, "i");
// Only the EXPLICIT amb-action fence executes. We deliberately do NOT accept a bare ```json block: a
// model showing example code (```json {"tool":...}) must never be executed as a real action.

/**
 * Parse an assisted-mode model reply.
 *  - a well-formed `amb-action` envelope ⇒ `action`
 *  - a plain answer with no action attempt ⇒ `final`
 *  - an ATTEMPTED action (mentions `amb-action`) that is unterminated/malformed/invalid ⇒ `error`
 *    (the caller feeds the message back so the model can repair — bounded retry)
 */
export function parseAssistedResponse(text: string): AssistedParse {
  const matches = [...text.matchAll(FENCE_RE_G)];
  if (matches.length === 0) {
    // No valid fence. If the model clearly TRIED (mentioned the fence name), nudge it to repair.
    if (new RegExp(ACTION_FENCE, "i").test(text)) {
      return {
        kind: "error",
        message: `Your ${ACTION_FENCE} block was not a complete, valid fenced block. Re-emit exactly one \`\`\`${ACTION_FENCE} … \`\`\` block containing a single JSON object.`,
        text,
      };
    }
    // A weak model may emit a BARE action object with no fence (`{"tool":"read","args":{…}}`). Returning
    // that as a final answer would silently drop the intended tool call and end the run — the biggest
    // small-model reliability gap. Detect a top-level object with a string `tool` key and nudge for the
    // fence instead (we NEVER execute an unfenced block).
    if (looksLikeBareAction(text)) {
      return {
        kind: "error",
        message: `Wrap your tool call in a fenced block: reply with EXACTLY one \`\`\`${ACTION_FENCE} … \`\`\` block containing the JSON object. Do not send bare JSON.`,
        text,
      };
    }
    return { kind: "final", text: text.trim() };
  }
  const actions: AssistedAction[] = [];
  for (const m of matches.slice(0, MAX_ACTIONS)) {
    const one = parseEnvelope((m[1] ?? "").trim());
    if (typeof one === "string") return { kind: "error", message: one, text };
    actions.push(one);
  }
  return { kind: "action", actions };
}

/** One envelope's JSON → an action, or the repair message for the model. */
function parseEnvelope(raw: string): AssistedAction | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `Your ${ACTION_FENCE} block was not valid JSON. Re-emit it as a single valid JSON object.`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `Your ${ACTION_FENCE} block must be a JSON OBJECT with "tool" and "args".`;
  }
  const obj = parsed as Record<string, unknown>;
  const tool = obj.tool;
  if (typeof tool !== "string" || tool.length === 0) {
    return `Your ${ACTION_FENCE} block is missing a string "tool" field.`;
  }
  // `args`, if present, must be a plain object (not a string/array/number) — else nudge to repair.
  const rawArgsVal = obj.args;
  if (
    rawArgsVal !== undefined &&
    (typeof rawArgsVal !== "object" || rawArgsVal === null || Array.isArray(rawArgsVal))
  ) {
    return `"args" in your ${ACTION_FENCE} block must be a JSON object.`;
  }
  const args = rawArgsVal ?? {};
  return { tool, args, rawArgs: JSON.stringify(args) };
}

/** Strip the action envelope(s) from the reply so the user sees only the model's reasoning text. */
export function stripActionBlock(text: string): string {
  // Remove complete fences first, then any dangling UNTERMINATED open fence through EOF.
  const stripped = text.replace(FENCE_RE_G, "").replace(OPEN_FENCE_RE, "").trim();
  // A weak model may emit a BARE action object with NO fence as its entire reply (`{"tool":…,"args":{…}}`).
  // That is an attempted tool call, not prose — never surface it as a finished answer (it would leak raw
  // protocol JSON, the "wall of {"command":…}" the user saw). We still don't EXECUTE an unfenced block
  // (parseAssistedResponse nudges the model to re-emit with the fence); we only refuse to DISPLAY it.
  if (looksLikeBareAction(stripped)) return "";
  return stripped;
}

/**
 * Streams an assisted-lane reply's prose as it arrives while holding back the action envelope: text is let
 * through up to a fence that is (or may still become) `amb-action`, and nothing after it; a reply that
 * begins like a bare JSON object is never streamed (it's a malformed call, not prose). The settled answer
 * still arrives as assistant.final, stripped the same way.
 */
export class AssistedDeltaFilter {
  private pending = "";
  private stopped = false;
  private started = false;

  /** What's still held when the reply ends — unless it's the start of an action block that never finished. */
  flush(): string {
    if (this.stopped) return "";
    const held = this.pending;
    this.pending = "";
    const lead = held.trimStart();
    const after = lead.startsWith("```") ? lead.slice(3).toLowerCase() : undefined;
    if (after !== undefined && after.length > 0 && ACTION_FENCE.startsWith(after)) return "";
    return this.started ? held : "";
  }

  push(text: string): string {
    if (this.stopped) return "";
    this.pending += text;
    if (!this.started) {
      const lead = this.pending.trimStart();
      if (lead.length === 0) return "";
      if (lead.startsWith("{")) {
        this.stopped = true;
        return "";
      }
      this.started = true;
    }
    let out = "";
    for (;;) {
      const at = this.pending.indexOf("```");
      if (at < 0) {
        // Hold trailing backticks (maybe a fence starting) and whitespace (maybe right before one).
        const tail = /\s*`{0,2}$/.exec(this.pending)?.[0].length ?? 0;
        out += this.pending.slice(0, this.pending.length - tail);
        this.pending = this.pending.slice(this.pending.length - tail);
        return out;
      }
      const after = this.pending.slice(at + 3).toLowerCase();
      // The info string must be exactly `amb-action` (as the parser reads it) — `amb-actionable` is ordinary.
      const next = after.startsWith(ACTION_FENCE) ? after[ACTION_FENCE.length] : "";
      if (after.startsWith(ACTION_FENCE) && next !== undefined && !/[a-z0-9_]/.test(next)) {
        out += this.pending.slice(0, at);
        this.pending = "";
        this.stopped = true;
        return out.trimEnd();
      }
      if (after.length <= ACTION_FENCE.length && ACTION_FENCE.startsWith(after)) {
        // Not enough yet to tell whether this fence is an action: hold it and the whitespace before it.
        const keep = this.pending.slice(0, at).trimEnd().length;
        out += this.pending.slice(0, keep);
        this.pending = this.pending.slice(keep);
        return out;
      }
      // An ordinary code fence: let it through and keep looking.
      out += this.pending.slice(0, at + 3);
      this.pending = this.pending.slice(at + 3);
    }
  }
}
