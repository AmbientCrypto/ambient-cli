import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ambHome } from "@amb/sessions";

/**
 * Prompt history per workspace (↑/↓ to recall, Ctrl+R to search), stored as JSON lines under the ambient home
 * so it survives restarts. Best-effort: an unreadable file just means an empty history.
 */
const MAX_ENTRIES = 500;

export function historyPath(workspaceRoot: string, home: string = ambHome()): string {
  const id = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return join(home, "history", `${id}.jsonl`);
}

/** Entries oldest → newest, de-duplicated against the immediately previous entry, capped. */
export function loadHistory(path: string): string[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let text: unknown;
    try {
      text = (JSON.parse(line) as { text?: unknown }).text;
    } catch {
      continue; // one damaged line (e.g. a write cut short) never loses the rest
    }
    if (typeof text === "string" && text.trim() && out[out.length - 1] !== text) out.push(text);
  }
  return out.slice(-MAX_ENTRIES);
}

export function appendHistory(path: string, text: string): void {
  if (!text.trim()) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ text, at: new Date().toISOString() })}\n`, "utf8");
  } catch {
    // best-effort
  }
}

/** Newest entry containing `query` (case-insensitive), searching back from `before` (exclusive). */
export function searchHistory(
  entries: readonly string[],
  query: string,
  before: number = entries.length,
): { index: number; text: string } | undefined {
  const q = query.toLowerCase();
  for (let i = Math.min(before, entries.length) - 1; i >= 0; i--) {
    const text = entries[i] as string;
    if (text.toLowerCase().includes(q)) return { index: i, text };
  }
  return undefined;
}

/** Where the composer is while walking history: `index` into the entries (undefined = the live draft). */
export interface HistoryNav {
  index?: number;
  /** What was in the composer before browsing started — restored when you walk back past the newest entry. */
  draft: string;
}

export const IDLE_NAV: HistoryNav = { draft: "" };

/** ↑: step to the previous entry (remembering the draft on the first step). `text` is undefined at the start. */
export function navOlder(
  entries: readonly string[],
  nav: HistoryNav,
  current: string,
): { nav: HistoryNav; text?: string } {
  if (entries.length === 0) return { nav };
  if (nav.index === undefined) {
    const index = entries.length - 1;
    return { nav: { index, draft: current }, text: entries[index] };
  }
  if (nav.index === 0) return { nav };
  const index = nav.index - 1;
  return { nav: { ...nav, index }, text: entries[index] };
}

/** ↓: step to the next entry, or back to the saved draft after the newest. Not browsing → nothing. */
export function navNewer(
  entries: readonly string[],
  nav: HistoryNav,
): { nav: HistoryNav; text?: string } {
  if (nav.index === undefined) return { nav };
  const index = nav.index + 1;
  if (index >= entries.length) return { nav: IDLE_NAV, text: nav.draft };
  return { nav: { ...nav, index }, text: entries[index] };
}
