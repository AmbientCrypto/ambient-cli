/** Tiny ANSI helpers that respect NO_COLOR and whether the target stream is a TTY. */

function enabled(stream: NodeJS.WriteStream): boolean {
  return !process.env.NO_COLOR && Boolean(stream.isTTY);
}

export const dim = (s: string): string => (enabled(process.stderr) ? `\x1b[2m${s}\x1b[0m` : s);
export const bold = (s: string): string => (enabled(process.stdout) ? `\x1b[1m${s}\x1b[0m` : s);
/** Ambient Cyan — the brand accent for live/informational lines (substitution receipts, handoffs). */
export const cyan = (s: string): string => (enabled(process.stderr) ? `\x1b[36m${s}\x1b[0m` : s);
/** Semantic success — diff additions + "passed" (green). Deliberately NOT the cyan accent (mirrors the TUI). */
export const add = (s: string): string => (enabled(process.stderr) ? `\x1b[32m${s}\x1b[0m` : s);
/** Semantic bad — errors + diff deletions (red). The Ambient palette has no amber. */
export const bad = (s: string): string => (enabled(process.stderr) ? `\x1b[31m${s}\x1b[0m` : s);
