import type { NewEvent } from "@amb/protocol";
import { AUTO_MODEL } from "@amb/reliability";
import { add, bad, cyan, dim } from "../render/color.js";

/**
 * Render runtime events to the terminal as they stream. Assistant text streams inline; tool calls
 * show a one-line status; diffs (from write/edit) preview before-and-after; the model receipt and
 * substitution are surfaced. This is the line-UI (source of truth) that the richer TUI builds on.
 */
export class EventRenderer {
  private streaming = false;

  handle(ev: NewEvent): void {
    switch (ev.kind) {
      case "model.resolved":
        // `auto` is the default pick, not a substitution — don't print "↪ auto → X (no model requested)".
        if (ev.targetModel !== ev.requestedModel && ev.requestedModel !== AUTO_MODEL) {
          process.stderr.write(
            `${cyan(`↪ ${ev.requestedModel} → ${ev.targetModel}`)} ${dim(`(${ev.reason ?? "substituted"})`)}\n`,
          );
        }
        break;
      case "assistant.delta":
        process.stdout.write(ev.text);
        this.streaming = ev.text.length > 0 || this.streaming;
        break;
      case "assistant.final":
        if (!this.streaming && ev.text) process.stdout.write(ev.text);
        this.streaming = false;
        break;
      case "tool.proposed":
        this.endLine();
        // The `plan` tool maintains a task list, not a real action — show a compact progress line, not raw args.
        if (ev.toolName === "plan") {
          process.stderr.write(cyan("  ◇ plan") + dim(` · ${planProgress(ev.args)}\n`));
        } else {
          process.stderr.write(dim(`  · ${ev.toolName} ${previewArgs(ev.args)}\n`));
        }
        break;
      case "handoff":
        this.endLine();
        process.stderr.write(
          cyan(`  ↪ ${ev.from} → ${ev.to}`) + dim(` (${ev.reason ?? ev.role})\n`),
        );
        break;
      case "error":
        this.endLine();
        process.stderr.write(
          `${
            bad(`  ⚠ ${ev.errorKind}: ${ev.message}`) + (ev.model ? dim(` (${ev.model})`) : "")
          }\n`,
        );
        break;
      case "context.overflow":
        this.endLine();
        process.stderr.write(
          dim(`  ⓘ context overflow on ${ev.model} — could not fit even after compaction\n`),
        );
        break;
      case "context.compacted":
        this.endLine();
        process.stderr.write(
          dim(`  ⓘ compacted context (${ev.summarizedPhases} messages summarized)\n`),
        );
        break;
      case "subagent.started":
        this.endLine();
        // color only the ◆ marker; keep the label/model dim (never nest dim() inside cyan()).
        process.stderr.write(`${cyan("  ◆ ")}${ev.role} ${dim(`[${ev.label}] ${ev.model}`)}\n`);
        break;
      case "subagent.tool": {
        const mark = ev.status === "running" ? "○" : ev.status === "ok" ? "✓" : "✗";
        process.stderr.write(
          dim(`     ${mark} ${ev.toolName}${ev.preview ? `  ${ev.preview}` : ""}\n`),
        );
        break;
      }
      case "subagent.finished":
        process.stderr.write(dim(`  ↳ ${ev.summary.replace(/\s+/g, " ").slice(0, 140)}\n`));
        break;
      case "verify.gate":
        this.endLine();
        process.stderr.write(
          ev.ok
            ? dim("  ✓ verification passed\n")
            : dim(
                `  ⚠ verification failed — re-asking the model to fix it\n${
                  ev.summary
                    ? `${ev.summary
                        .split("\n")
                        .slice(0, 8)
                        .map((l) => `    ${l}`)
                        .join("\n")}\n`
                    : ""
                }`,
              ),
        );
        break;
      case "tool.permission":
        if (ev.effect === "deny") process.stderr.write(dim(`    ✗ denied: ${ev.reason}\n`));
        break;
      case "tool.result": {
        // a failed result reads RED (✗ + timing), its error dim — one level of ANSI each, never nested.
        if (ev.ok) {
          process.stderr.write(dim(`    ✓ ${ev.durationMs}ms\n`));
        } else {
          process.stderr.write(
            `${bad(`    ✗ ${ev.durationMs}ms`)}${ev.error ? dim(` ${ev.error}`) : ""}\n`,
          );
        }
        // Preview the unified diff (write/edit OUTPUT) so a file change is visible in the line-UI too.
        if (ev.ok && ev.diff) this.writeDiff(ev.diff);
        break;
      }
      case "turn.finished":
        this.endLine();
        break;
      default:
        break;
    }
  }

  private endLine(): void {
    if (this.streaming) {
      process.stdout.write("\n");
      this.streaming = false;
    }
  }

  /** Print a bounded unified-diff preview (additions green, deletions red, context dim — semantic, never
   *  the cyan accent, so a big edit can't blow the accent budget; mirrors the TUI Diff + theme.ts). */
  private writeDiff(diff: string): void {
    const lines = diff.split("\n");
    const shown = lines.slice(0, 40);
    for (const l of shown) {
      if (l.startsWith("+") && !l.startsWith("+++")) process.stderr.write(`    ${add(l)}\n`);
      else if (l.startsWith("-") && !l.startsWith("---")) process.stderr.write(`    ${bad(l)}\n`);
      else process.stderr.write(dim(`    ${l}\n`));
    }
    if (lines.length > shown.length)
      process.stderr.write(dim(`    … ${lines.length - shown.length} more lines\n`));
  }
}

/** Compact `done/total` progress from a `plan` tool call's args (for the line-UI). */
function planProgress(args: unknown): string {
  const tasks = (args as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return "updated";
  const total = tasks.length;
  const done = tasks.filter((t) => (t as { status?: unknown })?.status === "done").length;
  return `${done}/${total} done`;
}

function previewArgs(args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.path === "string") return a.path;
    if (typeof a.command === "string") return `$ ${(a.command as string).slice(0, 60)}`;
    if (typeof a.pattern === "string") return `/${a.pattern}/`;
  }
  return "";
}
