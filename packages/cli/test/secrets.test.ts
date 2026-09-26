import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SecretRunner,
  deleteApiKey,
  maskKey,
  resolveApiKeyWithSource,
  saveApiKey,
} from "../src/secrets.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-secrets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("saving the API key", () => {
  it("macOS: the key goes to the keychain via STDIN, never in a command-line argument", () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const run: SecretRunner = (cmd, args, input) => {
      calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
      return "";
    };
    saveApiKey("sk-SECRET-123", { platform: "darwin", run, configDir: dir });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("security");
    expect(calls[0]?.args.join(" ")).not.toContain("sk-SECRET-123");
    expect(calls[0]?.input).toContain("sk-SECRET-123");
  });

  it("other platforms: a credentials file only the user can read (0600)", () => {
    saveApiKey("sk-LINUX", { platform: "linux", run: () => "", configDir: dir });
    const p = join(dir, "credentials.json");
    expect(JSON.parse(readFileSync(p, "utf8")).apiKey).toBe("sk-LINUX");
    if (process.platform !== "win32") expect(statSync(p).mode & 0o077).toBe(0); // Windows: no POSIX modes
    expect(
      resolveApiKeyWithSource({}, { platform: "linux", run: () => "", configDir: dir }),
    ).toEqual({
      key: "sk-LINUX",
      source: "file",
    });
  });

  it("rejects a key with whitespace or control characters (a botched paste)", () => {
    expect(() =>
      saveApiKey("sk bad\nkey", { platform: "linux", run: () => "", configDir: dir }),
    ).toThrow(/doesn't look like an API key/);
  });
});

describe("resolving + removing the key", () => {
  it("env wins and is reported as the source", () => {
    expect(
      resolveApiKeyWithSource(
        { AMBIENT_API_KEY: "sk-ENV" },
        { platform: "linux", run: () => "", configDir: dir },
      ),
    ).toEqual({ key: "sk-ENV", source: "env" });
  });
  it("logout removes the stored file", () => {
    saveApiKey("sk-XXXXXXXXXX", { platform: "linux", run: () => "", configDir: dir });
    deleteApiKey({ platform: "linux", run: () => "", configDir: dir });
    expect(
      resolveApiKeyWithSource({}, { platform: "linux", run: () => "", configDir: dir }),
    ).toBeUndefined();
  });
  it("masks all but the last 4 characters", () => {
    expect(maskKey("sk-abcdef123456")).toBe("…3456");
    expect(maskKey("abc")).toBe("…");
  });
});

describe("keychain read matches the write", () => {
  it("reads THIS CLI's own item (service + account) first, then another Ambient app's key", async () => {
    const { apiKeyCandidates } = await import("../src/secrets.js");
    const run: SecretRunner = (_cmd, args) => {
      if (args.includes("amb")) return "sk-own-cli-key-1111\n";
      if (args.includes("api-key")) return "sk-other-app-key-2222\n";
      throw new Error("not found");
    };
    const c = [...apiKeyCandidates({}, { platform: "darwin", run, configDir: dir })];
    expect(c).toEqual([
      { key: "sk-own-cli-key-1111", source: "keychain" },
      { key: "sk-other-app-key-2222", source: "keychain-shared" },
    ]);
  });
  it("save, read and delete all target the same service + account", () => {
    const seen: string[][] = [];
    const run: SecretRunner = (_c, args, input) => {
      seen.push(input ? [input] : args);
      return "";
    };
    saveApiKey("sk-same-account-1234", { platform: "darwin", run, configDir: dir });
    deleteApiKey({ platform: "darwin", run, configDir: dir });
    resolveApiKeyWithSource({}, { platform: "darwin", run, configDir: dir });
    const flat = seen.map((a) => a.join(" "));
    expect(flat[0]).toMatch(/-s "ambient\.xyz" -a "amb"/);
    expect(flat[1]).toMatch(/-s ambient\.xyz -a amb/);
    expect(flat[2]).toMatch(/-s ambient\.xyz -a amb/);
  });
});

describe("credentials file hardening", () => {
  it("refuses to write through a planted symlink", async () => {
    const { symlinkSync, writeFileSync } = await import("node:fs");
    const target = join(dir, "victim.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, "credentials.json"));
    expect(() =>
      saveApiKey("sk-SYMLINK-TEST", { platform: "linux", run: () => "", configDir: dir }),
    ).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });
  it("replaces an existing loose-permission file with a private one", async () => {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const p = join(dir, "credentials.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o644);
    saveApiKey("sk-REPLACED-1234", { platform: "linux", run: () => "", configDir: dir });
    if (process.platform !== "win32") expect(statSync(p).mode & 0o077).toBe(0); // Windows: no POSIX modes
  });
});

describe("lazy key lookup", () => {
  it("never reads another app's keychain item when this CLI's own key exists", async () => {
    const reads: string[] = [];
    const run: SecretRunner = (_cmd, args) => {
      reads.push(args.join(" "));
      if (args.includes("amb")) return "sk-own-cli-key-1111\n";
      return "sk-other-app-key-2222\n";
    };
    expect(resolveApiKeyWithSource({}, { platform: "darwin", run, configDir: dir })?.source).toBe(
      "keychain",
    );
    expect(reads.some((r) => r.includes("api-key"))).toBe(false);
  });
});

describe("Windows: the key is DPAPI-encrypted, never stored in plain text", () => {
  it("saves only the encrypted blob and passes the key to PowerShell on stdin", () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const run: SecretRunner = (cmd, args, input) => {
      calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
      return args.join(" ").includes("ConvertFrom-SecureString")
        ? "01000000d08c9ddf-ENCRYPTED\r\n"
        : "";
    };
    saveApiKey("sk-WINDOWS-KEY-5555", { platform: "win32", run, configDir: dir });
    const file = readFileSync(join(dir, "credentials.json"), "utf8");
    expect(file).not.toContain("sk-WINDOWS-KEY-5555");
    expect(JSON.parse(file).apiKeyDpapi).toBe("01000000d08c9ddf-ENCRYPTED");
    // The key is only ever on stdin — not on the command line, not in the script text.
    expect(calls[0]?.args.join(" ")).not.toContain("sk-WINDOWS-KEY-5555");
    expect(calls[0]?.input).toBe("sk-WINDOWS-KEY-5555\n");
    // PowerShell by absolute path, never a same-named program in the project folder.
    expect(calls[0]?.cmd).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  });
  it("reads it back by decrypting through PowerShell", () => {
    const run: SecretRunner = (_cmd, args, input) =>
      args.join(" ").includes("ConvertFrom-SecureString")
        ? "BLOB\r\n"
        : args.join(" ").includes("PtrToStringBSTR") && input === "BLOB\n"
          ? "sk-WINDOWS-KEY-5555\r\n"
          : "";
    saveApiKey("sk-WINDOWS-KEY-5555", { platform: "win32", run, configDir: dir });
    expect(resolveApiKeyWithSource({}, { platform: "win32", run, configDir: dir })).toEqual({
      key: "sk-WINDOWS-KEY-5555",
      source: "file",
    });
  });
});
