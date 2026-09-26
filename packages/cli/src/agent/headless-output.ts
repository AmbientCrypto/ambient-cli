import type { NewEvent } from "@amb/protocol";

/**
 * Machine-readable output for scripts, in Claude Code's `--output-format` shapes: `json` is one result
 * object at the end; `stream-json` is one JSON object per line — an init line, each assistant message (text
 * and tool calls), each tool result, then the result. Token counts are reported; costs never are.
 */

export type OutputFormat = "text" | "json" | "stream-json";

export function parseOutputFormat(v: string | undefined): OutputFormat | undefined {
  return v === "text" || v === "json" || v === "stream-json" ? v : undefined;
}

export interface RunSummary {
  stopReason: string;
  turns: number;
  finalText: string;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

const SUBTYPE: Record<string, string> = {
  complete: "success",
  max_turns: "error_max_turns",
  max_budget: "error_max_turns",
};

export class HeadlessOutput {
  private usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  private readonly started = Date.now();
  private apiMs = 0;
  private requestStart: number | undefined;
  private toolNames = new Map<string, string>();

  constructor(
    private readonly format: Exclude<OutputFormat, "text">,
    private readonly sessionId: string,
    private readonly write: (line: string) => void = (l) => process.stdout.write(l),
  ) {}

  private line(obj: unknown): void {
    this.write(`${JSON.stringify(obj)}\n`);
  }

  init(info: { cwd: string; model: string; permissionMode: string; tools: string[] }): void {
    if (this.format !== "stream-json") return;
    this.line({
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      cwd: info.cwd,
      model: info.model,
      permissionMode: info.permissionMode,
      tools: info.tools,
    });
  }

  handle(ev: NewEvent): void {
    switch (ev.kind) {
      case "inference.request":
        this.requestStart = Date.now();
        return;
      case "inference.response":
        if (this.requestStart !== undefined) this.apiMs += Date.now() - this.requestStart;
        this.requestStart = undefined;
        this.usage = {
          input_tokens: this.usage.input_tokens + (ev.promptTokens ?? 0),
          output_tokens: this.usage.output_tokens + (ev.completionTokens ?? 0),
          cache_read_input_tokens: this.usage.cache_read_input_tokens + (ev.cachedTokens ?? 0),
        };
        return;
      default:
        break;
    }
    if (this.format !== "stream-json") return;
    const msg = (role: "assistant" | "user", content: unknown[]) =>
      this.line({ type: role, message: { role, content }, session_id: this.sessionId });
    if (ev.kind === "assistant.final" && ev.text)
      msg("assistant", [{ type: "text", text: ev.text }]);
    else if (ev.kind === "tool.proposed") {
      this.toolNames.set(ev.toolCallId, ev.toolName);
      msg("assistant", [
        { type: "tool_use", id: ev.toolCallId, name: ev.toolName, input: ev.args ?? {} },
      ]);
    } else if (ev.kind === "tool.result") {
      msg("user", [
        {
          type: "tool_result",
          tool_use_id: ev.toolCallId,
          content: ev.ok ? (ev.preview ?? "") : (ev.error ?? "failed"),
          is_error: !ev.ok,
        },
      ]);
    }
  }

  result(r: RunSummary, error?: string): void {
    const subtype = error
      ? "error_during_execution"
      : (SUBTYPE[r.stopReason] ?? "error_during_execution");
    this.line({
      type: "result",
      subtype,
      is_error: subtype !== "success",
      duration_ms: Date.now() - this.started,
      duration_api_ms: this.apiMs,
      num_turns: r.turns,
      result: error ?? r.finalText,
      stop_reason: r.stopReason,
      session_id: this.sessionId,
      usage: this.usage,
    });
  }
}
