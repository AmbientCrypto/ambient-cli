import { Text } from "ink";
import type { ReactNode } from "react";
import { AmbientTheme } from "../theme.js";

/**
 * Small brand primitives shared across the TUI: thin rules for depth (not heavy borders),
 * cyan reserved for what's live/active/key.
 */

/** A thin horizontal rule — depth through a single light line, never a boxed border. */
export function Rule({
  width = 48,
  accent = false,
}: { width?: number; accent?: boolean }): ReactNode {
  return (
    <Text color={accent ? AmbientTheme.cyan : AmbientTheme.dim}>
      {"─".repeat(Math.max(1, width))}
    </Text>
  );
}
