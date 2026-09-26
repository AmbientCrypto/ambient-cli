import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AMBIENT_BANNER, BRAILLE_GLOBE, LOCKUP_COMPACT } from "../logo.js";
import { AmbientTheme } from "../theme.js";
import { Rule } from "./primitives.js";

/** One canonical tagline (capitalized), used in both the wide + compact lockups. */
const TAGLINE = "A terminal coding agent for the Ambient network.";

/** The wide lockup's true width: globe + a 3-col gap + the block wordmark. Drives the responsive breakpoint
 *  (measured, not a magic number) so the wordmark can never be forced to wrap on the very first screen. */
const LOCKUP_W = (BRAILLE_GLOBE[0]?.length ?? 20) + 3 + (AMBIENT_BANNER[0]?.length ?? 30);

/**
 * How many models Ambient offers right now. The catalog's readiness flag is only a hint (flagged models have
 * been seen serving), so the splash counts every model instead of reporting a misleading "none ready".
 */
export function readyLine(fleet?: { ready: number; total?: number }): {
  count: string;
  rest: string;
} {
  if (!fleet) return { count: "", rest: "connecting…" };
  const t = Math.max(fleet.total ?? 0, fleet.ready);
  if (t === 0) return { count: "", rest: "no models available" };
  return { count: String(t), rest: ` model${t === 1 ? "" : "s"} on Ambient` };
}

/**
 * The splash lockup — the one place we spend the brand's "10% cyan" boldly. The real Ambient globe
 * (braille art) + the block "AMBIENT" wordmark (Oswald-condensed spirit) + a terse, anti-hype tagline.
 * Degrades to a compact single-line lockup on narrow terminals (the responsive rule).
 */
export function Banner({
  width,
  fleet,
  version,
  update,
  short = false,
}: {
  width: number;
  /** Use the one-line lockup even when wide enough — the terminal is too short for the full banner. */
  short?: boolean;
  fleet?: { ready: number; total?: number };
  version?: string;
  update?: { latest: string; command: string };
}): ReactNode {
  const compact = short || width - 2 < LOCKUP_W; // account for the App's paddingX:1 (≈ width < 63)
  const { count, rest } = readyLine(fleet);
  // A subtle upgrade nudge, like Claude Code's — the version is always shown; the ▲ line only when behind. The
  // command matches how this binary was installed (brew vs a from-source/dev build).
  const upgradeLine = update ? (
    <Text color={AmbientTheme.cyan}>{`▲ ${update.latest} available — ${update.command}`}</Text>
  ) : null;
  const versionTag = version ? (
    <Text color={AmbientTheme.dim}>{`${count ? "  ·  " : ""}v${version}`}</Text>
  ) : null;

  if (compact) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={AmbientTheme.cyan} bold>
          {LOCKUP_COMPACT}
        </Text>
        <Text color={AmbientTheme.dim} wrap="truncate">
          {TAGLINE}
        </Text>
        <Text>
          {count ? <Text color={AmbientTheme.cyan}>{count}</Text> : null}
          <Text color={AmbientTheme.dim}>{rest}</Text>
          {versionTag}
        </Text>
        {upgradeLine}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box alignItems="center">
        <Box flexDirection="column" marginRight={3}>
          {BRAILLE_GLOBE.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed glyph rows never reorder
            <Text key={i} color={AmbientTheme.cyan}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          {AMBIENT_BANNER.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed glyph rows never reorder
            <Text key={i} color={AmbientTheme.cyan} bold>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={AmbientTheme.fg}>{TAGLINE}</Text>
        <Box marginTop={1}>
          {count ? (
            <Text color={AmbientTheme.cyan} bold>
              {count}
            </Text>
          ) : null}
          <Text color={AmbientTheme.dim}>{rest}</Text>
          {versionTag}
        </Box>
        {upgradeLine ? <Box>{upgradeLine}</Box> : null}
        <Box marginTop={1}>
          {/* dim rule — thin-line depth without spending more cyan; the wordmark keeps the accent concentrated */}
          <Rule width={Math.min(width - 2, 60)} />
        </Box>
      </Box>
    </Box>
  );
}
