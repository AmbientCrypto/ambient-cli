import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { KEYCHAIN_SERVICE } from "@amb/ambient-api";
import {
  type SecretEnv,
  dpapiProtect,
  dpapiUnprotect,
  resolveEnv,
  securityQuote,
} from "../secrets.js";

/**
 * Sign-in tokens for MCP servers, kept encrypted (AES-256-GCM) in a private file. The encryption key lives in
 * the macOS keychain, DPAPI-protected on Windows, and in a private file elsewhere — so the tokens are never
 * stored in the clear where the platform offers something better.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, if the server said. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

/** The registered OAuth client for a server's authorization server, reused across sign-ins. */
export interface StoredClient {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

export interface ServerAuthRecord {
  tokens?: StoredTokens;
  client?: StoredClient;
  /** The authorization server's token endpoint, for refreshing without rediscovery. */
  tokenEndpoint?: string;
  /** The resource the tokens are for (the server's URL). */
  resource?: string;
}

const KEY_ACCOUNT = "mcp-sign-in-key";

const storePath = (dir: string) => join(dir, "mcp-sign-in.json");
const keyFilePath = (dir: string) => join(dir, "mcp-sign-in.key");

/** One entry per server URL (hashed, so the file doesn't list which servers you use). */
export function serverKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("refusing a symlink");
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The store's encryption key, created on first use. */
function encryptionKey(e: SecretEnv, create: boolean): Buffer | undefined {
  const { platform, run, configDir } = resolveEnv(e);
  if (platform === "darwin") {
    try {
      const hex = run("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEY_ACCOUNT,
        "-w",
      ]).trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    } catch {
      // not created yet
    }
    if (!create) return undefined;
    const key = randomBytes(32);
    run(
      "security",
      ["-i"],
      `add-generic-password -U -s ${securityQuote(KEYCHAIN_SERVICE)} -a ${securityQuote(KEY_ACCOUNT)} -w ${securityQuote(key.toString("hex"))}\n`,
    );
    return key;
  }
  const file = keyFilePath(configDir);
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      const hex = platform === "win32" ? dpapiUnprotect(raw, run) : raw;
      if (hex && /^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    } catch {
      // unreadable — fall through
    }
  }
  if (!create) return undefined;
  const key = randomBytes(32);
  const hex = key.toString("hex");
  writePrivate(file, `${platform === "win32" ? dpapiProtect(hex, run) : hex}\n`);
  return key;
}

type Sealed = { iv: string; tag: string; data: string };

function seal(key: Buffer, value: unknown): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return {
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function open(key: Buffer, s: Sealed): unknown {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  const text = Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
  return JSON.parse(text);
}

function readAll(dir: string): Record<string, Sealed> {
  try {
    const parsed = JSON.parse(readFileSync(storePath(dir), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Sealed>) : {};
  } catch {
    return {};
  }
}

export interface TokenStore {
  get(url: string): ServerAuthRecord | undefined;
  set(url: string, record: ServerAuthRecord): void;
  delete(url: string): void;
}

export function makeTokenStore(e: SecretEnv = {}): TokenStore {
  const { configDir } = resolveEnv(e);
  return {
    get(url) {
      const sealed = readAll(configDir)[serverKey(url)];
      if (!sealed) return undefined;
      const key = encryptionKey(e, false);
      if (!key) return undefined;
      try {
        return open(key, sealed) as ServerAuthRecord;
      } catch {
        return undefined; // tampered or from another key — treat as signed out
      }
    },
    set(url, record) {
      const key = encryptionKey(e, true);
      if (!key) throw new Error("couldn't create the sign-in store's key");
      const next = { ...readAll(configDir), [serverKey(url)]: seal(key, record) };
      writePrivate(storePath(configDir), `${JSON.stringify(next, null, 2)}\n`);
    },
    delete(url) {
      const all = readAll(configDir);
      const k = serverKey(url);
      if (!(k in all)) return;
      const { [k]: _gone, ...rest } = all;
      writePrivate(storePath(configDir), `${JSON.stringify(rest, null, 2)}\n`);
    },
  };
}
