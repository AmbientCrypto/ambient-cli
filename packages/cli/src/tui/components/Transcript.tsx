import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { clipText } from "../clip.js";
import { mmss } from "../format.js";
import { globeFrame } from "../logo.js";
import { renderMarkdown } from "../markdown.js";
import type { TranscriptItem } from "../state.js";
import { AmbientTheme } from "../theme.js";
import { hardWrap } from "../wrap.js";

/** One line clipped to `max` display columns (width-correct for CJK/emoji). */
const clip = clipText;

// `hardWrap` moved to ../wrap.js (shared with the markdown renderer without a cycle); re-exported for callers
// (and the render test) that import it from here.
export { hardWrap };

/** A notice never grows taller than this in the live region (the full text is in the session log). */
const NOTICE_MAX_LINES = 24;

/** Cap an already-wrapped string to at most `n` lines with an honest elision — so a long error/output the user
 *  WANTS to read still wraps and stays readable, but a giant one can't grow the live region past the screen. */
function capLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : `${lines.slice(0, n).join("\n")}\n…`;
}

/** While an answer is STREAMING it renders in the live region (re-drawn, not yet in <Static>); cap its
 *  on-screen height so a long answer can't grow the dynamic tree past the terminal (which would force Ink's
 *  scrollback-erasing full clear). The full text commits to <Static> the instant it finalizes. */
const STREAM_MAX_LINES = 14;

/** Status glyph for a tool call (geometric marks — never emoji). Settled SUCCESS is GREEN (conventional), not
 *  the cyan accent — a run fills the transcript with ✓ rows, so cyan there would blow the ~10% budget. Only a
 *  LIVE tool carries the signal accent. */
function toolGlyph(status: "running" | "ok" | "fail"): { glyph: string; color: string } {
  if (status === "running") return { glyph: "◐", color: AmbientTheme.signal };
  if (status === "ok") return { glyph: "✓", color: AmbientTheme.add };
  return { glyph: "✗", color: AmbientTheme.bad };
}

/**
 * Render a unified diff with restrained, CONVENTIONAL color: additions green, deletions muted-red,
 * context dim. Diff green/red are semantic (not the Ambient Cyan accent) so a big edit can't blow the
 * ~10% cyan budget. Each line is truncated to the interior so a long/minified edit line can't wrap and
 * shatter the marginLeft gutter.
 */
function Diff({ diff, width }: { diff: string; width: number }): ReactNode {
  const lines = diff.split("\n");
  const shown = lines.slice(0, 40);
  const hidden = lines.length - shown.length;
  const inner = Math.max(1, width - 2); // marginLeft:2
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((l, i) => {
        let color: string = AmbientTheme.dim;
        if (l.startsWith("+") && !l.startsWith("+++")) color = AmbientTheme.add;
        else if (l.startsWith("-") && !l.startsWith("---")) color = AmbientTheme.bad;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff snapshot within one render never reorders
          <Text key={i} color={color} wrap="truncate">
            {clip(l || " ", inner)}
          </Text>
        );
      })}
      {hidden > 0 ? <Text color={AmbientTheme.dim}>{`  … ${hidden} more lines`}</Text> : null}
    </Box>
  );
}

/** A bounded, dimmed preview of a tool's OUTPUT (read contents / grep hits / bash stdout). */
function Output({ text, width }: { text: string; width: number }): ReactNode {
  const lines = text.split("\n");
  // The preview arrives already bounded (≤ ~8 lines + an honest marker) from the runtime, so show it whole
  // rather than re-slicing at 6 (which would drop the runtime's "+N more lines" marker).
  const shown = lines.slice(0, 12);
  const hidden = lines.length - shown.length;
  const inner = Math.max(1, width - 2);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a preview snapshot never reorders within a render
        <Text key={i} color={AmbientTheme.dim} wrap="truncate">
          {clip(l || " ", inner)}
        </Text>
      ))}
      {hidden > 0 ? <Text color={AmbientTheme.dim}>{`  … ${hidden} more lines`}</Text> : null}
    </Box>
  );
}

/** Render one transcript item. Exported so App can feed SETTLED items to Ink's <Static> (scrollback) with
 *  the exact same rendering as the live tail. */
export function TranscriptRow({
  item,
  width,
  maxStreamLines = STREAM_MAX_LINES,
  settled = false,
}: {
  item: TranscriptItem;
  width: number;
  maxStreamLines?: number;
  /** Printed once into scrollback (not the redrawn live area), so it needs no height cap. */
  settled?: boolean;
}): ReactNode {
  switch (item.kind) {
    case "user": {
      // A multi-line paste is echoed as a labelled summary ("[pasted N lines] <first line>…") so the user can
      // SEE that their paste landed (before, a multi-line prompt rendered as one truncated line — or a blank
      // "›" when it began with a newline). A single-line prompt wraps in full so nothing runs off the edge.
      const raw = item.text ?? "";
      const lines = raw.replace(/\n+$/, "").split("\n"); // ignore trailing blank lines in the count
      if (lines.length > 1) {
        const firstLine = lines.find((l) => l.trim().length > 0) ?? lines[0] ?? "";
        return (
          <Box marginTop={1} width={width}>
            <Box width={2} flexShrink={0}>
              <Text color={AmbientTheme.cyan}>›</Text>
            </Box>
            <Text color={AmbientTheme.dim}>{`[pasted ${lines.length} lines] `}</Text>
            <Text color={AmbientTheme.fg} wrap="truncate">
              {clip(firstLine, Math.max(8, width - 20))}
            </Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1} width={width}>
          {/* A fixed 2-column marker: when the prompt wraps, the layout would otherwise squeeze it to "›". */}
          <Box width={2} flexShrink={0}>
            <Text color={AmbientTheme.cyan}>›</Text>
          </Box>
          <Text color={AmbientTheme.fg} wrap="wrap">
            {hardWrap(raw, Math.max(8, width - 2))}
          </Text>
        </Box>
      );
    }

    case "assistant": {
      // SETTLED prose renders as Markdown (bold/headers/lists/code/tables) so raw `**`/`#`/`|` never show.
      // The LIVE streaming tail stays RAW (markers arrive unclosed mid-stream, and it commits to <Static> the
      // instant it finalizes) — capped to the last N lines + hard-broken so the live region can't outgrow the
      // screen. Each completed paragraph commits settled (splitCommittable) and thus renders Markdown as it goes.
      if (!item.streaming) {
        return (
          <Box marginTop={1} width={width}>
            {renderMarkdown(item.text, width)}
          </Box>
        );
      }
      const wrapped = hardWrap(item.text, width);
      let shown = wrapped;
      const cap = Math.max(3, maxStreamLines);
      const lines = wrapped.split("\n");
      if (lines.length > cap) {
        shown = `…\n${lines.slice(lines.length - cap).join("\n")}`;
      }
      return (
        <Box marginTop={1} width={width}>
          <Text color={AmbientTheme.fg} wrap="wrap">
            {shown}
            <Text color={AmbientTheme.cyan}>{` ${globeFrame(item.spin, true)}`}</Text>
          </Text>
        </Box>
      );
    }

    case "tool": {
      // Skills get a FRIENDLY, prominent treatment so it's clear a skill was used:
      // a clear "using skill: X" / "searched skills: X" line with the brand ◆ (the same mark the /skills
      // browser puts on a pinned skill) — no raw JSON dump. This is the visible proof a skill was loaded.
      if (item.name === "skill" || item.name === "search_skills") {
        const isLoad = item.name === "skill";
        const running = item.status === "running";
        const failed = item.status === "fail";
        const mark = running ? "◐" : failed ? "✗" : "◆";
        const markColor = running
          ? AmbientTheme.signal
          : failed
            ? AmbientTheme.bad
            : AmbientTheme.cyan;
        const label = isLoad
          ? running
            ? "loading skill"
            : "using skill"
          : running
            ? "searching skills"
            : "searched skills";
        return (
          <Box marginTop={1}>
            <Text color={markColor}>{`${mark} `}</Text>
            <Text color={AmbientTheme.fg}>{label}</Text>
            {item.preview ? (
              <Text color={AmbientTheme.cyan} bold>
                {`: ${clip(item.preview, Math.max(4, width - label.length - 6))}`}
              </Text>
            ) : null}
            {item.error ? (
              <Text color={AmbientTheme.bad} wrap="truncate">
                {`  ${clip(item.error, Math.max(1, width - label.length - 8))}`}
              </Text>
            ) : null}
          </Box>
        );
      }
      const { glyph, color } = toolGlyph(item.status);
      const timing = item.durationMs != null ? ` ${item.durationMs}ms` : "";
      const exit = item.exitCode != null && item.exitCode !== 0 ? ` exit ${item.exitCode}` : "";
      // Budget the preview so the header (glyph + name + preview + timing + exit) never wraps — exit is a
      // priority suffix (you need to see it), so reserve its width here. When there's no real room left,
      // DROP the preview rather than floor it at 8 (a floor would just overflow the row and split the
      // exit suffix onto a second line on a very narrow terminal); name/timing/exit are the priority.
      const previewBudget = width - item.name.length - timing.length - exit.length - 6;
      const showPreview = Boolean(item.preview) && previewBudget >= 8;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={color}>{`${glyph} `}</Text>
            <Text color={AmbientTheme.fg} wrap="truncate">
              {item.name}
            </Text>
            {showPreview ? (
              <Text color={AmbientTheme.dim}>{`  ${clip(item.preview, previewBudget)}`}</Text>
            ) : null}
            {timing ? <Text color={AmbientTheme.dim}>{timing}</Text> : null}
            {exit ? <Text color={AmbientTheme.bad}>{exit}</Text> : null}
          </Box>
          {item.diff ? <Diff diff={item.diff} width={width} /> : null}
          {item.resultPreview ? <Output text={item.resultPreview} width={width} /> : null}
          {item.error ? (
            // WRAP the error (a failed glob/grep/bash often carries a long path) so it's fully readable across
            // lines instead of running off the right edge; capped so a giant error can't grow the live region.
            <Box marginLeft={2}>
              <Text color={AmbientTheme.bad} wrap="wrap">
                {capLines(hardWrap(item.error, Math.max(8, width - 4)), 8)}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }

    case "subagent-line": {
      // The DURABLE scrollback record of a subagent wave — scroll up to read what each scout did.
      if (item.variant === "done") {
        const ok = item.okCount ?? 0;
        const partial = item.partialCount ?? 0;
        const fail = item.failCount ?? 0;
        // Only surface a breakdown when something wasn't a clean OK; list only the non-zero buckets.
        const parts = [
          `${ok} ok`,
          ...(partial > 0 ? [`${partial} partial`] : []),
          ...(fail > 0 ? [`${fail} failed`] : []),
        ];
        return (
          <Box>
            <Text color={AmbientTheme.dim} wrap="truncate">
              {`◆ ${item.count ?? 0} ${item.count === 1 ? item.roleWord.replace(/s$/, "") : item.roleWord} finished${
                partial > 0 || fail > 0 ? ` (${parts.join(" · ")})` : ""
              }`}
            </Text>
          </Box>
        );
      }
      // ok → green ✓, partial (returned findings but hit its turn limit) → blue ◐, fail → red ✗.
      const mark =
        item.childStatus === "fail" ? "✗ " : item.childStatus === "partial" ? "◐ " : "✓ ";
      const markColor =
        item.childStatus === "fail"
          ? AmbientTheme.bad
          : item.childStatus === "partial"
            ? AmbientTheme.signal
            : AmbientTheme.add;
      const meta = `${item.turns ?? 0} turn${item.turns === 1 ? "" : "s"}${
        item.durationMs != null ? ` · ${mmss(Math.round(item.durationMs / 1000))}` : ""
      }`;
      const summary = item.summary
        ? capLines(hardWrap(item.summary, Math.max(8, width - 4)), 6)
        : "";
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={markColor}>{mark}</Text>
            <Text color={AmbientTheme.fg}>{`${item.label ?? ""}  `}</Text>
            <Text color={AmbientTheme.dim}>{meta}</Text>
          </Box>
          {summary ? (
            <Box>
              <Text color={AmbientTheme.dim} wrap="wrap">
                {`  ${summary}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }

    case "handoff":
      // The user's own mid-run switch reads as a calm receipt, not a failover.
      if (item.role === "user") {
        return (
          <Box marginTop={1}>
            <Text color={AmbientTheme.signal}>↪ </Text>
            <Text color={AmbientTheme.dim} wrap="truncate">
              {clip(`switched to ${item.to} — continuing from here`, Math.max(1, width - 2))}
            </Text>
          </Box>
        );
      }
      // A role handoff (planner→executor→…) — distinct glyph ⇢ from the ↪ substitution receipt below.
      return (
        <Box marginTop={1}>
          <Text color={AmbientTheme.dim} wrap="truncate">
            {clip(`⇢ ${item.from} → ${item.to} (${item.reason ?? item.role})`, width)}
          </Text>
        </Box>
      );

    case "thought":
      // How long the model reasoned before answering or acting — the live reasoning tail is gone by now.
      return (
        <Box marginTop={1}>
          <Text color={AmbientTheme.dim} wrap="truncate">
            {clip(
              `∴ Thought ${item.seconds < 1 ? "briefly" : `for ${formatSeconds(item.seconds)}`}${item.effort && item.effort !== "none" ? ` · ${item.effort}` : ""}`,
              width,
            )}
          </Text>
        </Box>
      );

    case "receipt":
      // A calm, honest receipt (warm-model substitution) — never an alarm.
      return (
        <Box marginTop={1}>
          <Text color={AmbientTheme.signal}>↪ </Text>
          <Text color={AmbientTheme.dim} wrap="truncate">
            {clip(item.text, Math.max(1, width - 2))}
          </Text>
        </Box>
      );

    case "notice": {
      const color =
        item.level === "error"
          ? AmbientTheme.bad
          : item.level === "warn"
            ? AmbientTheme.signal
            : AmbientTheme.dim;
      // A notice that already leads with its own glyph (⚠ ◆ ✓ ↪ …) keeps it — never "⚠ ⚠". Multi-line notices
      // (/help, verify diagnostics) wrap and keep their lines instead of being flattened into one clipped row.
      const hasGlyph = /^[⚠◆✓✗↪·▲◉∴]/u.test(item.text);
      const mark = hasGlyph ? "" : item.level === "info" ? "· " : "⚠ ";
      // An explicit width: scrollback rows are laid out outside the padded frame, so without it a long note
      // wraps at the full terminal width and spills a character onto its own line. Only the live area caps
      // the line count; in scrollback the whole note (e.g. /help) prints.
      const wrapped = hardWrap(`${mark}${item.text}`, Math.max(8, width - 1));
      return (
        <Box marginTop={1} width={Math.max(8, width)}>
          <Text color={color} wrap="wrap">
            {settled ? wrapped : capLines(wrapped, NOTICE_MAX_LINES)}
          </Text>
        </Box>
      );
    }

    default:
      return null;
  }
}

/**
 * The transcript — a calm, borderless column. Used for the LIVE tail (in-flight items); the settled history
 * is printed once into terminal scrollback via <Static> in App. `width` is threaded down so every volatile
 * line truncates/wraps within the interior.
 */
export function Transcript({
  items,
  width = 80,
  maxStreamLines = STREAM_MAX_LINES,
}: {
  items: TranscriptItem[];
  width?: number;
  maxStreamLines?: number;
}): ReactNode {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TranscriptRow key={item.id} item={item} width={width} maxStreamLines={maxStreamLines} />
      ))}
    </Box>
  );
}

/** "12s", "1m 05s". */
function formatSeconds(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
