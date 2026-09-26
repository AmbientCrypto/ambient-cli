import { execFileSync } from "node:child_process";
import { KEYS_URL, resolveConfig, verifyApiKey } from "@amb/ambient-api";
import { windowsSystemExe } from "@amb/tools-core";
import { bold, cyan, dim } from "../render/color.js";
import {
  KEY_SOURCE_LABEL,
  deleteApiKey,
  maskKey,
  resolveApiKey,
  resolveApiKeyWithSource,
  saveApiKey,
} from "../secrets.js";
import { readSecret } from "../terminal/read-secret.js";

/** The command that opens a URL in the default browser, with no shell in between: on Windows `cmd /c start`
 *  would read a `&` in the URL as a command separator, cutting the link and running the rest. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  if (platform === "darwin") return ["open", [u.toString()]];
  // By full path: a bare name would also be looked up in the current folder (a cloned repo's rundll32.exe).
  if (platform === "win32")
    return [windowsSystemExe("rundll32.exe"), ["url.dll,FileProtocolHandler", u.toString()]];
  return ["xdg-open", [u.toString()]];
}

/** Best-effort open the URL in the user's default browser. Returns false if it couldn't launch. */
export function openBrowser(url: string): boolean {
  const cmd = browserCommand(url);
  if (!cmd) return false;
  try {
    execFileSync(cmd[0], cmd[1], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort copy text to the clipboard (pbcopy / clip.exe / wl-copy / xclip). False if unavailable. */
function copyToClipboard(text: string): boolean {
  const tools: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [[windowsSystemExe("clip.exe"), []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
          ];
  for (const [cmd, args] of tools) {
    try {
      execFileSync(cmd, args, {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      return true;
    } catch {
      // not installed — try the next one
    }
  }
  return false;
}

/** Paste attempts before giving up (a mistyped key gets a second and third chance, not a dead end). */
const MAX_KEY_ATTEMPTS = 3;

/**
 * The interactive sign-in flow, shared by `ambient login` and the first launch without a key. Opens the keys
 * page, reads the key hidden, checks it against Ambient (free — no model runs), and saves it only when it's
 * accepted (or when the check couldn't reach Ambient). Returns whether a key was saved. Never prints the key.
 */
export async function signInInteractive(opts: { firstRun?: boolean } = {}): Promise<boolean> {
  if (opts.firstRun) {
    process.stdout.write(
      `\n${bold("Welcome to Ambient")}\n${dim("Connect your Ambient account to start — it takes a minute.")}\n\n`,
    );
  } else {
    process.stdout.write(`\n${bold("Connect your Ambient account")}\n\n`);
    if (resolveApiKey()) {
      process.stdout.write(dim("You're already signed in — this will replace your saved key.\n\n"));
    }
  }

  const opened = openBrowser(KEYS_URL);
  process.stdout.write(
    opened
      ? `1. Opened ${cyan(KEYS_URL)} in your browser — create a key there and copy it.\n`
      : `1. Open ${cyan(KEYS_URL)} in your browser — create a key there and copy it.\n`,
  );
  if (!opened && copyToClipboard(KEYS_URL)) {
    process.stdout.write(dim("   (The link is on your clipboard.)\n"));
  }
  process.stdout.write(
    `2. Paste it below. ${dim("It stays hidden and is stored securely on this machine.")}\n\n`,
  );

  const { baseUrl } = resolveConfig();
  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
    const key = await readSecret(`${cyan("API key")}${dim(" (hidden): ")}`);
    if (!key) {
      process.stderr.write("No key entered — nothing was saved.\n");
      return false;
    }
    process.stdout.write(dim("Checking the key with Ambient…\n"));
    const check = await verifyApiKey({ baseUrl, apiKey: key });
    if (check === "invalid") {
      const left = MAX_KEY_ATTEMPTS - attempt;
      process.stdout.write(
        left > 0
          ? `Ambient rejected that key. Copy it again from ${cyan(KEYS_URL)} and paste it (${left} ${left === 1 ? "try" : "tries"} left).\n\n`
          : "Ambient rejected that key — nothing was saved. Run `ambient login` to try again.\n",
      );
      continue;
    }
    try {
      saveApiKey(key);
    } catch (err) {
      process.stderr.write(
        `Could not save the key: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return false;
    }
    process.stdout.write(
      check === "valid"
        ? `\n${cyan("✓")} Signed in (key ${maskKey(key)}).\n\n`
        : `\n${cyan("✓")} Saved key ${maskKey(key)} — couldn't reach Ambient to check it right now; it will be used on your next request.\n\n`,
    );
    return true;
  }
  process.exitCode = 1;
  return false;
}

/**
 * `ambient login` — connect your Ambient account (see signInInteractive).
 */
export async function runLogin(): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "ambient login needs an interactive terminal. Or set AMBIENT_API_KEY in your environment.\n",
    );
    process.exitCode = 1;
    return;
  }
  const ok = await signInInteractive();
  if (ok) process.stdout.write(`You're ready — run ${bold("ambient")}.\n\n`);
  else process.exitCode = 1;
}

/** `ambient logout` — remove the saved key from this machine. */
export function runLogout(): void {
  const before = resolveApiKeyWithSource();
  deleteApiKey();
  const after = resolveApiKeyWithSource();
  if (after) {
    process.stdout.write(
      `Removed this CLI's saved key. Still signed in with ${maskKey(after.key)} from ${KEY_SOURCE_LABEL[after.source]}.\n`,
    );
    return;
  }
  process.stdout.write(
    before ? `Signed out — removed key ${maskKey(before.key)}.\n` : "You weren't signed in.\n",
  );
}
