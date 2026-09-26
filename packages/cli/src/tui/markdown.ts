import { Box, Text } from "ink";
import { type ReactNode, createElement } from "react";
import { AmbientTheme } from "./theme.js";
import { hardWrap } from "./wrap.js";

/**
 * A small, tasteful Markdown → Ink renderer for assistant prose, so a model's `**bold**`, `# headers`,
 * bullet/numbered lists, `inline code`, ```fences```, > quotes, --- rules, [links](url) and | tables |
 * render as formatted terminal text instead of showing their raw syntax. It is intentionally NOT a full
 * CommonMark engine — it handles the constructs models actually emit, degrades gracefully (an unmatched
 * marker stays literal), and stays width-safe (every run is `hardWrap`-broken so nothing spills off-screen).
 * Applied only to SETTLED assistant text (the live streaming tail stays raw — see Transcript).
 */

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

// Order matters: code first (its content is literal), then bold (`**`) before italic (`*`), then links.
const INLINE_RULES: Array<{ re: RegExp; make: (m: RegExpExecArray) => InlineSpan }> = [
  { re: /^`([^`]+)`/, make: (m) => ({ text: m[1] as string, code: true }) },
  { re: /^\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/, make: (m) => ({ text: m[1] as string, bold: true }) },
  { re: /^\*([^\s*](?:[^*]*[^\s*])?)\*/, make: (m) => ({ text: m[1] as string, italic: true }) },
  {
    re: /^\[([^\]]+)\]\(([^)\s]+)\)/,
    make: (m) => ({ text: m[1] as string, href: m[2] as string }),
  },
];

/** Split a single line of prose into styled runs. Pure — the unit-tested core. Unmatched markers stay literal. */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain) spans.push({ text: plain });
    plain = "";
  };
  while (i < text.length) {
    const c = text[i];
    let matched = false;
    if (c === "`" || c === "*" || c === "[") {
      const rest = text.slice(i);
      for (const { re, make } of INLINE_RULES) {
        const m = re.exec(rest);
        if (m) {
          flush();
          spans.push(make(m));
          i += m[0].length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      plain += c;
      i++;
    }
  }
  flush();
  return spans;
}

const CODE_COLOR = AmbientTheme.cyan;
const DIM = AmbientTheme.dim;

/** Render inline spans as (possibly nested) <Text> runs; each run's text is hard-wrapped to stay on-screen. */
function renderSpans(spans: InlineSpan[], width: number): ReactNode[] {
  return spans.map((s, idx) => {
    const content = hardWrap(s.text, Math.max(8, width));
    const key = idx; // inline runs of a single settled line never reorder — a stable index key is fine
    if (s.code) return createElement(Text, { key, color: CODE_COLOR }, content);
    if (s.href)
      return createElement(
        Text,
        { key },
        createElement(Text, { underline: true }, content),
        createElement(Text, { color: DIM }, ` (${s.href})`),
      );
    return createElement(Text, { key, bold: s.bold, italic: s.italic }, content);
  });
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorRow = (cells: string[]) =>
  cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));

/** Parse a `| a | b |` row into trimmed cells (dropping the outer pipes). */
function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Render a run of table rows as aligned, width-fitted columns (header bold + a rule); cells truncate to fit. */
function renderTable(rows: string[], width: number, key: number): ReactNode {
  const body = rows.map(tableCells).filter((c) => !isSeparatorRow(c));
  if (body.length === 0) return createElement(Text, { key }, "");
  const cols = Math.max(...body.map((r) => r.length));
  const colW = new Array(cols).fill(0);
  for (const r of body)
    for (let c = 0; c < cols; c++) colW[c] = Math.max(colW[c], (r[c] ?? "").length);
  // Shrink the widest column until the whole row fits the terminal (" │ " separators between columns).
  const sepW = 3;
  const budget = Math.max(cols * 4, width - 1);
  let total = colW.reduce((a, b) => a + b, 0) + sepW * (cols - 1);
  while (total > budget) {
    const mi = colW.indexOf(Math.max(...colW));
    if ((colW[mi] ?? 0) <= 4) break;
    colW[mi]--;
    total--;
  }
  const fit = (s: string, w: number) =>
    s.length <= w ? s.padEnd(w) : `${s.slice(0, Math.max(1, w - 1))}…`;
  const rowText = (cells: string[]) => colW.map((w, c) => fit(cells[c] ?? "", w)).join(" │ ");
  const nodes: ReactNode[] = [];
  nodes.push(
    createElement(Text, { key: "h", bold: true, wrap: "truncate" }, rowText(body[0] ?? [])),
  );
  nodes.push(
    createElement(
      Text,
      { key: "r", color: DIM, wrap: "truncate" },
      colW.map((w) => "─".repeat(w)).join("─┼─"),
    ),
  );
  for (let r = 1; r < body.length; r++)
    nodes.push(createElement(Text, { key: `b${r}`, wrap: "truncate" }, rowText(body[r] ?? [])));
  return createElement(Box, { key, flexDirection: "column" }, nodes);
}

/**
 * Render Markdown `text` into an Ink node (a column of block lines). Width-aware + safe on any input.
 */
export function renderMarkdown(text: string, width: number): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let inFence = false;
  let key = 0;
  const w = Math.max(8, width);
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) {
      inFence = !inFence; // drop the ``` delimiter line itself
      i++;
      continue;
    }
    if (inFence) {
      out.push(
        createElement(
          Box,
          { key: key++ },
          createElement(Text, { color: DIM }, "│ "),
          createElement(Text, { color: CODE_COLOR }, hardWrap(line, w - 2)),
        ),
      );
      i++;
      continue;
    }
    if (isTableRow(line)) {
      const rows: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        rows.push(lines[i] as string);
        i++;
      }
      out.push(renderTable(rows, w, key++));
      continue;
    }
    if (line.trim() === "") {
      out.push(createElement(Box, { key: key++, height: 1 }));
      i++;
      continue;
    }
    const header = /^(#{1,6})\s+(.*)$/.exec(line);
    if (header) {
      out.push(
        createElement(
          Text,
          { key: key++, bold: true, wrap: "wrap" },
          renderSpans(parseInline(header[2] as string), w),
        ),
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(createElement(Text, { key: key++, color: DIM }, "─".repeat(Math.min(w, 48))));
      i++;
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(
        createElement(
          Box,
          { key: key++ },
          createElement(Text, { color: DIM }, "│ "),
          createElement(Text, { color: DIM, wrap: "wrap" }, hardWrap(quote[1] as string, w - 2)),
        ),
      );
      i++;
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(
        createElement(
          Box,
          { key: key++ },
          createElement(Text, { color: DIM }, `${bullet[1]}• `),
          createElement(
            Text,
            { wrap: "wrap" },
            renderSpans(parseInline(bullet[2] as string), w - 2),
          ),
        ),
      );
      i++;
      continue;
    }
    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(
        createElement(
          Box,
          { key: key++ },
          createElement(Text, { color: DIM }, `${numbered[1]}${numbered[2]}. `),
          createElement(
            Text,
            { wrap: "wrap" },
            renderSpans(parseInline(numbered[3] as string), w - 3),
          ),
        ),
      );
      i++;
      continue;
    }
    out.push(createElement(Text, { key: key++, wrap: "wrap" }, renderSpans(parseInline(line), w)));
    i++;
  }
  return createElement(Box, { flexDirection: "column" }, out);
}
