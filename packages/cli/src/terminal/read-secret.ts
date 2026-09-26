import { normalizePastedText } from "../tui/capture.js";
/**
 * Read a line WITHOUT echoing it — for pasting an API key so it never appears on screen or in scrollback.
 * Uses only PUBLIC stdin APIs (raw mode + `data` events), not the private readline `_writeToOutput` field,
 * and ALWAYS restores the terminal in `finally` (even on error). Ctrl-C / Ctrl-D end the input as empty.
 */
export async function readSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Non-interactive: fall back to a single line from stdin (no echo control possible / needed).
    return readLineFromPipe();
  }
  process.stdout.write(promptText);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer): void => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n" || ch === "\x04") {
            // Enter or Ctrl-D → done.
            stdin.removeListener("data", onData);
            resolve(cleanSecretInput(buf));
            return;
          }
          if (ch === "\x03") {
            // Ctrl-C → treat as an empty entry (the caller reports "nothing saved").
            stdin.removeListener("data", onData);
            resolve("");
            return;
          }
          if (ch === "\x7f" || ch === "\b") {
            buf = buf.slice(0, -1); // backspace
            continue;
          }
          if (ch >= " " || ch === "\x1b") buf += ch; // keep ESC so paste markers can be stripped whole
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
    process.stdout.write("\n");
  }
}

/** Read one line from a non-TTY stdin (piped input) — used when there's no terminal to control echo on. */
function readLineFromPipe(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        resolve(cleanSecretInput(buf.slice(0, nl)));
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", () => resolve(cleanSecretInput(buf)));
  });
}

/**
 * Clean a pasted secret: the shared paste normalizer drops bracketed-paste markers (with or without their ESC
 * byte) and other escape/control sequences; then surrounding whitespace is trimmed.
 */
export function cleanSecretInput(raw: string): string {
  return normalizePastedText(raw).trim();
}
