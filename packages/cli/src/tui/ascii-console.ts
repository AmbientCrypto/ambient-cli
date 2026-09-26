/**
 * Legacy Windows consoles (conhost with raster/Consolas fonts, no font fallback) draw braille, box-drawing
 * corners and symbols like ✓ ⚠ as empty boxes. There, every such glyph is swapped for a SINGLE-column ASCII
 * equivalent at the last moment (on write), so Ink's width math — and the layout — is unchanged. Windows
 * Terminal, VS Code and every macOS/Linux terminal render the real glyphs and are left alone.
 */
const MAP: Record<string, string> = {
  "✓": "+",
  "✗": "x",
  "◐": "*",
  "◓": "*",
  "◑": "*",
  "◒": "*",
  "⚠": "!",
  "▸": ">",
  "›": ">",
  "↪": ">",
  "⇢": ">",
  "⤴": "^",
  "▲": "^",
  "◆": "*",
  "◉": "o",
  "●": "*",
  "○": "o",
  "◫": "#",
  "∴": ":",
  "…": ".",
  "·": ".",
  "—": "-",
  "–": "-",
  "│": "|",
  "┃": "|",
  "─": "-",
  "━": "-",
  "╭": "+",
  "╮": "+",
  "╰": "+",
  "╯": "+",
  "┌": "+",
  "┐": "+",
  "└": "+",
  "┘": "+",
  "▕": "[",
  "▏": "]",
  "█": "#",
  "▉": "#",
  "▊": "#",
  "▋": "#",
  "▌": "#",
  "▍": "#",
  "▎": "#",
  "░": ".",
  "▒": ":",
};

/** Replace non-ASCII UI glyphs with one-column ASCII (braille → `*`); leaves all other text untouched. */
export function toAsciiGlyphs(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2800 && cp <= 0x28ff)
      out += cp === 0x2800 ? " " : "*"; // braille (globe, spinners)
    else out += MAP[ch] ?? ch;
  }
  return out;
}

/** Whether this console needs the ASCII fallback. `AMBIENT_ASCII=1|0` forces it on or off. */
export function needsAsciiFallback(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.AMBIENT_ASCII === "1") return true;
  if (env.AMBIENT_ASCII === "0") return false;
  if (platform !== "win32") return false;
  // Windows Terminal, VS Code, ConEmu and mintty all render Unicode; only the legacy console does not.
  return !(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI || env.TERM?.startsWith("xterm"));
}

/** Route every write to `stream` through the ASCII fallback. Returns a function that restores it. */
export function installAsciiFallback(stream: NodeJS.WriteStream): () => void {
  const original = stream.write;
  // Transliterate string chunks only; buffers and the callback/encoding arguments pass through untouched.
  const patched = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
    const text = typeof chunk === "string" ? toAsciiGlyphs(chunk) : chunk;
    return (original as (...a: unknown[]) => boolean).call(this, text, ...rest);
  };
  stream.write = patched as typeof stream.write;
  return () => {
    stream.write = original;
  };
}
