import { Box, Text } from "ink";
import { clipText, stringWidth } from "../clip.js";
import { AmbientTheme } from "../theme.js";
import type { HistorySearch as SearchState } from "../use-prompt-history.js";

/** The Ctrl+R prompt-history search line, shown just above the composer while searching. */
export function HistorySearch({ search, width }: { search: SearchState; width: number }) {
  const shown =
    search.match !== undefined
      ? search.match
      : search.query
        ? "no match"
        : "type to search your previous prompts";
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={AmbientTheme.cyan}>search history </Text>
        <Text>{search.query}</Text>
        <Text color={AmbientTheme.dim}>
          {" → "}
          {clipText(shown, Math.max(10, width - stringWidth(search.query) - 20))}
        </Text>
      </Text>
      <Text color={AmbientTheme.dim}>enter use · ctrl+r older · esc cancel</Text>
    </Box>
  );
}
