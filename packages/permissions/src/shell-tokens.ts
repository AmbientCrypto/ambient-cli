/**
 * A tiny, LINEAR, quote-aware shell tokenizer for the risk classifier. It exists so risk matching operates on
 * real command tokens instead of backtracking regexes over the raw line (which were O(n²) and mis-fired on
 * quoted text). Not a real shell parser: it splits a command into pipeline/sequence segments, strips
 * quotes, records whether the first word was FULLY quoted (⇒ data, not an invocation), and bounds the input.
 */

export const MAX_CMD_CHARS = 16_000;

export interface ShellCommand {
  /** Ordered, quote-stripped tokens for one pipeline/sequence segment (argv[0] = command). */
  argv: string[];
  /** True if argv[0] was fully quoted — it's DATA (e.g. inside `printf`), never a real invocation. */
  quotedFirst: boolean;
}

interface Token {
  text: string;
  fullyQuoted: boolean;
  isOp: boolean;
}

function isWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\r";
}
function isOpChar(c: string): boolean {
  return c === "|" || c === "&" || c === ";" || c === "\n";
}

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i] as string;
    if (isWs(c)) {
      i++;
      continue;
    }
    if (isOpChar(c)) {
      let j = i;
      while (j < n && isOpChar(src[j] as string)) j++;
      toks.push({ text: src.slice(i, j), fullyQuoted: false, isOp: true });
      i = j;
      continue;
    }
    let text = "";
    let sawQuote = false;
    let sawUnquoted = false;
    while (i < n && !isWs(src[i] as string) && !isOpChar(src[i] as string)) {
      const ch = src[i] as string;
      if (ch === '"' || ch === "'") {
        sawQuote = true;
        i++;
        while (i < n && src[i] !== ch) {
          text += src[i];
          i++;
        }
        if (i < n) i++; // consume the closing quote
      } else if (ch === "\\" && i + 1 < n) {
        sawUnquoted = true;
        text += src[i + 1];
        i += 2;
      } else {
        sawUnquoted = true;
        text += ch;
        i++;
      }
    }
    toks.push({ text, fullyQuoted: sawQuote && !sawUnquoted, isOp: false });
  }
  return toks;
}

/** Parse a command line into its pipeline/sequence segments (bounded, linear). */
export function parseShellCommands(command: string): ShellCommand[] {
  const src = command.length > MAX_CMD_CHARS ? command.slice(0, MAX_CMD_CHARS) : command;
  const segments: Token[][] = [[]];
  for (const t of tokenize(src)) {
    if (t.isOp) segments.push([]);
    else (segments[segments.length - 1] as Token[]).push(t);
  }
  const out: ShellCommand[] = [];
  for (const seg of segments) {
    const first = seg[0];
    if (!first) continue;
    out.push({ argv: seg.map((t) => t.text), quotedFirst: first.fullyQuoted });
  }
  return out;
}

/** The command basename (drops a leading path: `/bin/rm` → `rm`). */
export function baseName(name: string): string {
  const parts = name.split(/[\\/]/); // POSIX and Windows separators
  return parts[parts.length - 1] ?? name;
}
