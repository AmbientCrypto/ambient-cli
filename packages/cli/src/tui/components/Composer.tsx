import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { quickNote } from "../../agent/memory-port.js";
import { clampCursor, composerTextWidth, layoutRows, offsetToRowCol } from "../editor.js";
import type { AgentMode } from "../state.js";
import { AmbientTheme } from "../theme.js";

/** Mode → colour for the composer's border tint + label pill. Matches the StatusLine: PLAN calm (gray),
 *  BUILD active (signal blue). Reverse-video makes the pill read big regardless. */
function modeColor(m: AgentMode): string {
  return m === "plan" ? AmbientTheme.dim : AmbientTheme.signal;
}

/** Human-readable byte size for an attachment chip. */
function kb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The FLOOR for the composer's height (rows). The App passes a larger `maxRows` when there's free vertical
 *  space (a fresh screen), so a big paste can expand into it; it stays here while a run is active or on a
 *  short terminal, so the live region never reaches the terminal height (the CSI-3J strobe + scrollback erase). */
const MIN_INPUT_ROWS = 6;

/** One visual row of the editor. When `caretUnit` is set, the ▋ caret is drawn INLINE at that code-unit
 *  offset within the row's text (splitting the run), so you can edit anywhere — not just at the end. */
function Row({
  text,
  first,
  caretUnit,
}: {
  text: string;
  first?: boolean;
  caretUnit?: number;
}): ReactNode {
  const gutter = <Text color={AmbientTheme.dim}>{first ? "▸ " : "  "}</Text>;
  if (caretUnit === undefined) {
    return (
      <Text wrap="truncate-end">
        {gutter}
        <Text color={AmbientTheme.fg}>{text}</Text>
      </Text>
    );
  }
  const at = Math.max(0, Math.min(caretUnit, text.length));
  return (
    <Text wrap="truncate-end">
      {gutter}
      <Text color={AmbientTheme.fg}>{text.slice(0, at)}</Text>
      <Text color={AmbientTheme.signal}>▋</Text>
      <Text color={AmbientTheme.fg}>{text.slice(at)}</Text>
    </Text>
  );
}

/** Pick a window of `maxRows` visual rows around the caret, reserving one row for a "… N above/below" marker
 *  on each truncated side. Guarantees the caret row is inside the window. */
function pickWindow(
  total: number,
  caretRow: number,
  maxRows: number,
): { start: number; count: number; above: number; below: number } {
  if (total <= maxRows) return { start: 0, count: total, above: 0, below: 0 };
  const around = (budget: number): number => {
    const b = Math.max(1, budget);
    return Math.max(0, Math.min(caretRow - Math.floor(b / 2), total - b));
  };
  const guess = Math.max(1, maxRows - 2);
  const s1 = around(guess);
  const reserve = (s1 > 0 ? 1 : 0) + (s1 + guess < total ? 1 : 0);
  const content = Math.max(1, maxRows - reserve);
  const start = around(content);
  return { start, count: content, above: start, below: total - (start + content) };
}

/**
 * Render the editable buffer as a WINDOW of visual rows around the caret (not a "[pasted N lines]" chip), with
 * the ▋ caret drawn inline at the cursor — so a large paste can be arrowed through and edited in place. The box
 * grows up to `maxRows`; beyond that it scrolls the window and shows "… N above/below" markers.
 */
function EditorView({
  value,
  cursor,
  width,
  maxRows,
}: {
  value: string;
  cursor: number;
  width: number;
  maxRows: number;
}): ReactNode {
  const usable = composerTextWidth(width);
  const rows = layoutRows(value, usable);
  const caret = clampCursor(value, cursor);
  const { row: caretRow } = offsetToRowCol(rows, caret);
  const { start, count, above, below } = pickWindow(rows.length, caretRow, maxRows);
  const shown = rows.slice(start, start + count);
  return (
    <Box flexDirection="column">
      {above > 0 ? (
        <Text
          color={AmbientTheme.cyan}
          wrap="truncate-end"
        >{`  … ${above} more line${above === 1 ? "" : "s"} above`}</Text>
      ) : null}
      {shown.map((r, i) => {
        const idx = start + i;
        return (
          <Row
            key={r.startOffset}
            text={r.text}
            first={idx === 0}
            caretUnit={idx === caretRow ? caret - r.startOffset : undefined}
          />
        );
      })}
      {below > 0 ? (
        <Text
          color={AmbientTheme.cyan}
          wrap="truncate-end"
        >{`  … ${below} more line${below === 1 ? "" : "s"} below`}</Text>
      ) : null}
    </Box>
  );
}

/**
 * The input box — ALWAYS visible (idle and in-flight), so there's never any doubt where you type.
 * A clean rounded frame that grows as the text wraps. While a run is active,
 * typing queues a follow-up for the next run; the placeholder + hint say so. App owns the keystrokes.
 */
export function Composer({
  value,
  cursor = value.length,
  running,
  width,
  agentMode = "build",
  maxRows = MIN_INPUT_ROWS,
  planReady = false,
  planReview = false,
  planReviewSteps = 0,
  attachments = [],
  visionNote,
}: {
  value: string;
  /** Caret offset into `value` (composer editing). Defaults to end (back-compat for callers/tests). */
  cursor?: number;
  running: boolean;
  width: number;
  /** PLAN vs BUILD — tints the composer border + shows a mode pill so you always know where you are. */
  agentMode?: AgentMode;
  /** How many rows of content the composer may show — the App raises this when there's free vertical space
   *  (a fresh screen) so a big paste expands; it stays at the floor while running / on a short terminal. */
  maxRows?: number;
  /** BUILD mode with a saved plan and idle → Enter on an empty line executes the plan. */
  planReady?: boolean;
  /** PLAN mode just produced a plan and is waiting for the user → Enter approves & builds; typing revises. */
  planReview?: boolean;
  /** How many undone steps the ready plan has (shown in the plan-review header). */
  planReviewSteps?: number;
  /** Pending image attachments shown as chips above the input (Ctrl+V / drag-drop / /attach). */
  attachments?: { bytes: number }[];
  /** What will happen to the image with the chosen model (e.g. "glm can't see images — qwen will describe it"). */
  visionNote?: string;
}): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 120));
  const rows = Math.max(MIN_INPUT_ROWS, maxRows);
  const placeholder = running
    ? "Steer the agent — type to redirect it, it picks it up next turn…"
    : planReview
      ? "type to revise · ↵ approves"
      : planReady
        ? "Enter to build the plan · or describe a task · type / for commands"
        : "Describe a coding task · type / for commands";
  const hint = running
    ? "enter steers the agent · esc cancels"
    : quickNote(value) !== undefined
      ? "enter saves this note to the project's memory · /memory to see notes"
      : "tab plan/build · shift+tab permission · enter runs · ctrl+c quits";

  return (
    <Box flexDirection="column">
      {attachments.length > 0 ? (
        // ◫ = an attached image (geometric mark, no emoji); cyan is the one live accent. Backspace on an empty
        // line removes the most recent.
        <Box paddingX={1}>
          <Text color={AmbientTheme.cyan}>◫ </Text>
          <Text color={AmbientTheme.dim} wrap="truncate-end">
            {attachments.length === 1
              ? `image attached · ${kb(attachments[0]?.bytes ?? 0)} · ⌫ removes`
              : `${attachments.length} images attached · ⌫ removes the last`}
          </Text>
        </Box>
      ) : null}
      {attachments.length > 0 && visionNote ? (
        <Box paddingX={1}>
          <Text color={AmbientTheme.dim} wrap="truncate-end">{`  ${visionNote}`}</Text>
        </Box>
      ) : null}
      {/* The label on the input frame + its border colour. In plan-review it's the SINGLE approve/revise
          prompt — an ENUMERATED choice (one action per line, key-labelled) so it reads unmistakably as a
          decision, not a run-on status line; signal-coloured, one element (no second banner). Otherwise a bold
          reverse-video mode pill so PLAN vs BUILD is unmistakable where you type. */}
      {planReview ? (
        <Box flexDirection="column" paddingX={1} width={boxW}>
          <Text wrap="truncate-end">
            <Text color={AmbientTheme.signal} bold>
              ◆ Plan ready
            </Text>
            <Text color={AmbientTheme.dim}>{` · ${planReviewSteps} step${
              planReviewSteps === 1 ? "" : "s"
            }`}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color={AmbientTheme.signal}>{"  ↵              "}</Text>
            <Text color={AmbientTheme.fg}>approve &amp; build</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color={AmbientTheme.signal}>{"  type a note    "}</Text>
            <Text color={AmbientTheme.dim}>revise the plan</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color={AmbientTheme.signal}>{"  ⇥ Tab          "}</Text>
            <Text color={AmbientTheme.dim}>keep planning</Text>
          </Text>
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text
            color={modeColor(agentMode)}
            inverse
            bold
          >{` ${agentMode === "plan" ? "PLAN" : "BUILD"} `}</Text>
        </Box>
      )}
      <Box
        borderStyle="round"
        borderColor={planReview ? AmbientTheme.signal : modeColor(agentMode)}
        paddingX={1}
        width={boxW}
      >
        {/* the prompt ▸ is dim chrome; the signal ▋ caret is the one live mark. When empty the caret leads the
            placeholder; while typing the input WRAPS (grows down, up to `rows`) so you can READ the whole
            message you're sending — never truncated off the right edge ("I can't read what I am sending"). */}
        {value.length === 0 ? (
          <Text wrap="truncate-end">
            <Text color={AmbientTheme.dim}>▸ </Text>
            <Text color={AmbientTheme.signal}>▋</Text>
            <Text color={AmbientTheme.dim}>{placeholder}</Text>
          </Text>
        ) : (
          // The editable buffer as a window of visual rows with the caret drawn inline — arrow-navigable +
          // editable anywhere, single-line or a big multi-line paste.
          <EditorView value={value} cursor={cursor} width={width} maxRows={rows} />
        )}
      </Box>
      <Box paddingX={1}>
        <Text color={AmbientTheme.dim} wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
