import type { AskRequest } from "@amb/protocol";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { clipText } from "../clip.js";
import { AmbientTheme } from "../theme.js";

/** The live state of an open questionnaire — the App owns it (refs for synchronous key handling). */
export interface QuestionState {
  req: AskRequest;
  /** Option index under the ▸ cursor. */
  cursor: number;
  /** Toggled option indices (multi-select). For single-select the cursor IS the selection. */
  selected: Set<number>;
  /** Free-text the user is typing (when the question allows it). */
  text: string;
}

/** One line clipped to `max` display columns (width-correct for CJK/emoji). */
const clip = clipText;

/**
 * The interactive questionnaire (backs the `ask_user` tool) — the agent pushes a real decision to the human
 * with selectable options AND a free-text field, instead of asking in plain prose. Same framed, signal-bordered
 * language as the Approval modal. ↑/↓ move the option cursor; Tab toggles a choice when multi-select; typing
 * fills the note; Enter submits; Esc skips (the agent proceeds on its best judgment).
 */
export function Question({ state, width }: { state: QuestionState; width: number }): ReactNode {
  const { req, cursor, selected, text } = state;
  const boxW = Math.max(0, Math.min(width - 2, 100));
  const inner = Math.max(4, boxW - 4); // paddingX:2
  const options = req.options ?? [];
  const multi = req.multiSelect === true;
  const allowText = req.allowText !== false;
  const idW = Math.max(10, Math.min(40, inner - 24)); // fixed label column → straight description edge

  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={2}
    >
      {/* A calm dim label anchors the panel; the question itself is the bold headline — no cramped "?" glyph. */}
      <Text color={AmbientTheme.dim}>a question for you</Text>
      <Box marginTop={1}>
        <Text color={AmbientTheme.fg} bold wrap="truncate">
          {clip(req.question, inner)}
        </Text>
      </Box>
      {options.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {options.map((o, i) => {
            const active = i === cursor;
            const mark = multi ? (selected.has(i) ? "◆" : "○") : active ? "●" : "○";
            const markColor = multi
              ? selected.has(i)
                ? AmbientTheme.cyan
                : AmbientTheme.dim
              : active
                ? AmbientTheme.cyan
                : AmbientTheme.dim;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed option list never reorders in a render
              <Box key={i}>
                <Box width={2} flexShrink={0}>
                  <Text color={AmbientTheme.cyan}>{active ? "▸ " : "  "}</Text>
                </Box>
                <Box width={2} flexShrink={0}>
                  <Text color={markColor}>{`${mark} `}</Text>
                </Box>
                <Box width={idW} flexShrink={0}>
                  <Text
                    color={active ? AmbientTheme.cyan : AmbientTheme.fg}
                    bold={active}
                    wrap="truncate"
                  >
                    {o.label}
                  </Text>
                </Box>
                {o.description ? (
                  <Box flexGrow={1}>
                    <Text color={AmbientTheme.dim} wrap="truncate">
                      {`  ${o.description}`}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : null}
      {allowText ? (
        <Box marginTop={options.length > 0 ? 1 : 0}>
          <Text color={AmbientTheme.dim}>{options.length > 0 ? "note: " : "answer: "}</Text>
          <Text color={AmbientTheme.fg}>{clip(text, inner - 8)}</Text>
          <Text color={AmbientTheme.signal}>▋</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={AmbientTheme.dim} wrap="truncate">
          {clip(
            options.length > 0
              ? `↑/↓ move · ${multi ? "tab select · " : ""}${allowText ? "type a note · " : ""}enter submit · esc skip`
              : "type your answer · enter submit · esc skip",
            inner,
          )}
        </Text>
      </Box>
    </Box>
  );
}
