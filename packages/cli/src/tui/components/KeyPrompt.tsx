import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { KeyPromptState } from "../key-flow.js";
import { AmbientTheme } from "../theme.js";

const TITLE: Record<KeyPromptState["reason"], string> = {
  rejected: "Ambient rejected your API key",
  "invalid-at-start": "Your saved Ambient key doesn't work",
  change: "Change your Ambient API key",
};

const WHY: Record<KeyPromptState["reason"], string> = {
  rejected:
    "It may have been revoked or mistyped. Paste a working key and your request will run again.",
  "invalid-at-start": "It may have been revoked. Paste a working key to continue.",
  change: "The new key is checked with Ambient before it replaces the saved one.",
};

/**
 * The in-app key panel — same framed, signal-bordered language as the question and approval panels. The key
 * is only ever shown as a masked length, never echoed. Esc keeps the current key.
 */
export function KeyPrompt({
  state,
  width,
  keysUrl,
}: {
  state: KeyPromptState;
  width: number;
  keysUrl: string;
}): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 100));
  const masked =
    state.value.length === 0
      ? "paste your key"
      : `${"•".repeat(Math.min(24, state.value.length))}  ${state.value.length} chars`;
  const status =
    state.status === "checking"
      ? { text: "Checking the key with Ambient…", color: AmbientTheme.dim }
      : state.status === "rejected"
        ? {
            text: "Ambient rejected that key — copy it again and paste it.",
            color: AmbientTheme.bad,
          }
        : undefined;

  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={2}
    >
      <Text color={AmbientTheme.dim}>API key</Text>
      <Box marginTop={1}>
        <Text color={AmbientTheme.fg} bold wrap="truncate">
          {TITLE[state.reason]}
        </Text>
      </Box>
      <Text color={AmbientTheme.dim} wrap="wrap">
        {WHY[state.reason]}
      </Text>
      <Text color={AmbientTheme.dim} wrap="truncate">
        {`Get a key at ${keysUrl}`}
      </Text>
      <Box marginTop={1}>
        <Text color={AmbientTheme.cyan}>{"▸ "}</Text>
        <Text color={state.value.length === 0 ? AmbientTheme.dim : AmbientTheme.fg} wrap="truncate">
          {masked}
        </Text>
      </Box>
      {status ? (
        <Text color={status.color} wrap="truncate">
          {status.text}
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={AmbientTheme.dim} wrap="truncate">
          enter save · ctrl+o open the keys page · esc keep current key
        </Text>
      </Box>
    </Box>
  );
}
