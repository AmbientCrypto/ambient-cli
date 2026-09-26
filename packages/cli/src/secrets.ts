import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KEYCHAIN_SERVICE } from "@amb/ambient-api";
import { windowsPowerShellExe } from "@amb/tools-core";

/** The friendly "you're not signed in" message — shown by commands that need a key in a non-interactive shell. */
export const NOT_SIGNED_IN = [
  "You're not signed in to Ambient yet.",
  "",
  "  Run:  ambient login",
  "",
  "That opens your Ambient keys page and saves your key securely on this machine.",
  "(Or set AMBIENT_API_KEY in your environment.)",
].join("\n");

/** Shown when Ambient rejects the saved key mid-use (revoked, expired or mistyped). */
export const KEY_REJECTED = [
  "Ambient rejected your API key — it may have been revoked or mistyped.",
  "  Fix it:  ambient login      (or type /login inside ambient)",
].join("\n");

/** Keychain account for our own entry — shared by save so replacement (`-U`) always targets the same item. */
export const KEYCHAIN_ACCOUNT = "amb";

/** Runs a system command, optionally feeding `input` on stdin; returns stdout. Injectable for tests. */
export type SecretRunner = (cmd: string, args: string[], input?: string) => string;

export interface SecretEnv {
  platform?: NodeJS.Platform;
  run?: SecretRunner;
  /** Directory for the credentials file on platforms without a keychain. */
  configDir?: string;
}

/** Where a key came from. `keychain-shared` = an ambient.xyz keychain item saved by another Ambient app. */
export type KeySource = "env" | "keychain" | "keychain-shared" | "file";

/** Human wording for where a key came from. */
export const KEY_SOURCE_LABEL: Record<KeySource, string> = {
  env: "AMBIENT_API_KEY",
  keychain: "your keychain",
  "keychain-shared": "another Ambient app's saved key",
  file: "your credentials file",
};

export interface KeyCandidate {
  key: string;
  source: KeySource;
}

const defaultRun: SecretRunner = (cmd, args, input) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(input !== undefined ? { input } : {}),
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "ignore"],
  });

function defaultConfigDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.AMB_CONFIG_HOME ?? env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "amb");
}

export const resolveEnv = (e: SecretEnv) => ({
  platform: e.platform ?? process.platform,
  run: e.run ?? defaultRun,
  configDir: e.configDir ?? defaultConfigDir(),
});

const credentialsPath = (dir: string) => join(dir, "credentials.json");

/** A pasted key must be a single token of printable characters (catches a botched multi-line paste). */
function assertKeyShape(key: string): void {
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) {
    throw new Error("that doesn't look like an API key (it should be one line with no spaces)");
  }
}

/** Quote a value for the `security -i` command reader (double quotes, escaping `\` and `"`). */
export function securityQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Persist the API key. macOS: the login keychain, written through `security -i` with the command on STDIN, so
 * the key never appears in a process argument list (visible to other processes via `ps`). Elsewhere: a
 * credentials file readable only by the user (0600). Errors are secret-free.
 */
export function saveApiKey(key: string, e: SecretEnv = {}): void {
  const clean = key.trim();
  assertKeyShape(clean);
  const { platform, run, configDir } = resolveEnv(e);
  if (platform === "darwin") {
    const cmd = `add-generic-password -U -s ${securityQuote(KEYCHAIN_SERVICE)} -a ${securityQuote(KEYCHAIN_ACCOUNT)} -w ${securityQuote(clean)}\n`;
    try {
      run("security", ["-i"], cmd);
    } catch {
      throw new Error("could not write to the macOS keychain (is it unlocked?)");
    }
    return;
  }
  const p = credentialsPath(configDir);
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    chmodSync(dirname(p), 0o700);
    // Never follow a planted symlink at the credentials path.
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error("symlink");
    // Windows ignores the 0600 mode, so there the key is stored DPAPI-encrypted (bound to this Windows
    // account); POSIX gets a plain 0600 file.
    const record =
      platform === "win32" ? { apiKeyDpapi: dpapiProtect(clean, run) } : { apiKey: clean };
    // Write a fresh private temp file (exclusive create, 0600) and rename it over the target, so the key is
    // never readable through looser permissions an existing file might have.
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(tmp, p);
    } catch (err) {
      rmSync(tmp, { force: true }); // never leave a stray copy of the key behind
      throw err;
    }
  } catch {
    throw new Error(`could not write ${p}`);
  }
}

/**
 * Windows DPAPI via PowerShell (by absolute path, never a same-named program in the project folder). The key
 * travels on STDIN and the fixed script reads it from there — the key never appears on the command line or in
 * the script text, which PowerShell logging can record. The blob only decrypts for the same Windows user.
 */
const DPAPI_PROTECT =
  "$k = [Console]::In.ReadLine(); $s = ConvertTo-SecureString -String $k -AsPlainText -Force; ConvertFrom-SecureString -SecureString $s";
const DPAPI_UNPROTECT =
  "$b = [Console]::In.ReadLine(); $s = ConvertTo-SecureString -String $b; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

export function dpapiProtect(key: string, run: SecretRunner): string {
  const out = run(
    windowsPowerShellExe(),
    ["-NoProfile", "-NonInteractive", "-Command", DPAPI_PROTECT],
    `${key}\n`,
  ).trim();
  if (!out) throw new Error("DPAPI encryption failed");
  return out;
}

export function dpapiUnprotect(blob: string, run: SecretRunner): string | undefined {
  const out = run(
    windowsPowerShellExe(),
    ["-NoProfile", "-NonInteractive", "-Command", DPAPI_UNPROTECT],
    `${blob}\n`,
  ).trim();
  return out || undefined;
}

/** Remove the stored key (keychain entry and/or credentials file). Idempotent. */
export function deleteApiKey(e: SecretEnv = {}): void {
  const { platform, run, configDir } = resolveEnv(e);
  if (platform === "darwin") {
    try {
      run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
    } catch {
      // no entry — fine
    }
  }
  rmSync(credentialsPath(configDir), { force: true });
}

/** The keychain account other Ambient apps save their key under (same service). */
export const SHARED_KEYCHAIN_ACCOUNT = "api-key";

/**
 * Every key available on this machine, lazily and in priority order: env AMBIENT_API_KEY, this CLI's own
 * keychain item (account `amb`), the key another Ambient app saved (account `api-key`), then the credentials
 * file. Reading the CLI's OWN item first matters — save/delete target it — and the lazy order means another
 * app's item is only read when nothing earlier is available.
 */
export function* apiKeyCandidates(
  env: Record<string, string | undefined> = process.env,
  e: SecretEnv = {},
): Generator<KeyCandidate> {
  const seen = new Set<string>();
  const emit = (key: string | undefined, source: KeySource): KeyCandidate | undefined => {
    if (!key || seen.has(key)) return undefined;
    seen.add(key);
    return { key, source };
  };
  const fromEnv = emit(env.AMBIENT_API_KEY?.trim(), "env");
  if (fromEnv) yield fromEnv;
  const { platform, run, configDir } = resolveEnv(e);
  if (platform === "darwin") {
    const read = (account: string): string | undefined => {
      try {
        return (
          run("security", [
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            account,
            "-w",
          ]).trim() || undefined
        );
      } catch {
        return undefined;
      }
    };
    const own = emit(read(KEYCHAIN_ACCOUNT), "keychain");
    if (own) yield own;
    const shared = emit(read(SHARED_KEYCHAIN_ACCOUNT), "keychain-shared");
    if (shared) yield shared;
  }
  const p = credentialsPath(configDir);
  if (existsSync(p)) {
    try {
      const rec = JSON.parse(readFileSync(p, "utf8")) as {
        apiKey?: unknown;
        apiKeyDpapi?: unknown;
      };
      const key =
        typeof rec.apiKeyDpapi === "string"
          ? dpapiUnprotect(rec.apiKeyDpapi, run)
          : String(rec.apiKey ?? "").trim();
      const file = emit(key, "file");
      if (file) yield file;
    } catch {
      // unreadable/corrupt/undecryptable — ignore
    }
  }
}

/** The key to use and where it came from (the first candidate), or undefined when signed out. */
export function resolveApiKeyWithSource(
  env: Record<string, string | undefined> = process.env,
  e: SecretEnv = {},
): KeyCandidate | undefined {
  for (const c of apiKeyCandidates(env, e)) return c;
  return undefined;
}

/** Resolve the Ambient API key (env, keychain, credentials file). Never logs the value. */
export function resolveApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return resolveApiKeyWithSource(env)?.key;
}

/** Show only the last 4 characters of a key. */
export function maskKey(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}
