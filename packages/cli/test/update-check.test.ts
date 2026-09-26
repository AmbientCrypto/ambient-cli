import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkForUpdate,
  installKind,
  isNewer,
  parseSemver,
  updateCommand,
  updateHint,
} from "../src/update-check.js";

describe("parseSemver / isNewer", () => {
  it("parses clean semvers and rejects the rest", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v0.4.0")).toEqual([0, 4, 0]);
    expect(parseSemver("dev")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("1.2.3-rc1")).toBeNull();
  });

  it("compares semvers component-by-component (not lexically)", () => {
    expect(isNewer("0.4.0", "0.3.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true); // NOT a string compare
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.3.0", "0.3.0")).toBe(false);
    expect(isNewer("0.3.0", "0.4.0")).toBe(false);
    expect(isNewer("0.4.0", "dev")).toBe(false); // an un-bundled build is never "behind"
  });
});

describe("checkForUpdate", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "amb-upd-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const base = () => ({ cacheDir: dir, now: () => 1_000_000, env: {} as Record<string, string> });

  it("reports an available update and writes the cache", async () => {
    const info = await checkForUpdate({
      ...base(),
      current: "0.4.0",
      fetchLatest: async () => "0.5.0",
    });
    expect(info).toEqual({ current: "0.4.0", latest: "0.5.0", updateAvailable: true });
    const cache = JSON.parse(await readFile(join(dir, "amb", "update-check.json"), "utf8"));
    expect(cache.latest).toBe("0.5.0");
    expect(cache.checkedAt).toBe(1_000_000);
  });

  it("says up-to-date when the latest equals the current", async () => {
    const info = await checkForUpdate({
      ...base(),
      current: "0.5.0",
      fetchLatest: async () => "0.5.0",
    });
    expect(info?.updateAvailable).toBe(false);
  });

  it("uses a FRESH cache without hitting the network", async () => {
    let fetches = 0;
    const fetchLatest = async () => {
      fetches++;
      return "0.5.0";
    };
    await checkForUpdate({ ...base(), current: "0.4.0", fetchLatest }); // primes the cache
    const info = await checkForUpdate({
      ...base(),
      current: "0.4.0",
      now: () => 1_000_000 + 60_000, // 1 min later — still well within the TTL
      fetchLatest,
    });
    expect(fetches).toBe(1); // the second call reused the cache
    expect(info?.updateAvailable).toBe(true);
  });

  it("falls back to a stale cache when the fetch fails", async () => {
    await checkForUpdate({ ...base(), current: "0.4.0", fetchLatest: async () => "0.5.0" });
    const info = await checkForUpdate({
      ...base(),
      current: "0.4.0",
      now: () => 1_000_000 + 100 * 60 * 60 * 1000, // long past the TTL → tries to fetch
      fetchLatest: async () => null, // …but the network is down
    });
    expect(info?.latest).toBe("0.5.0"); // served from the stale cache, not lost
  });

  it("is disabled by config, env opt-out, CI, and an un-bundled (dev) build", async () => {
    const f = async () => "0.5.0";
    expect(
      await checkForUpdate({ ...base(), current: "0.4.0", enabled: false, fetchLatest: f }),
    ).toBeNull();
    expect(
      await checkForUpdate({
        ...base(),
        current: "0.4.0",
        env: { AMBIENT_NO_UPDATE_CHECK: "1" },
        fetchLatest: f,
      }),
    ).toBeNull();
    expect(
      await checkForUpdate({ ...base(), current: "0.4.0", env: { CI: "true" }, fetchLatest: f }),
    ).toBeNull();
    expect(await checkForUpdate({ ...base(), current: "dev", fetchLatest: f })).toBeNull();
  });

  it("returns null (never throws) when there is no cache and no network", async () => {
    expect(
      await checkForUpdate({ ...base(), current: "0.4.0", fetchLatest: async () => null }),
    ).toBeNull();
  });

  it("updateHint names the version and the install-appropriate command", () => {
    const info = { current: "0.4.0", latest: "0.5.0", updateAvailable: true } as const;
    expect(updateHint(info, "brew")).toContain("0.5.0");
    expect(updateHint(info, "brew")).toContain("brew upgrade ambient-code");
    expect(updateHint(info, "source")).toContain("git pull");
    expect(updateHint(info, "source")).not.toContain("brew upgrade");
  });
});

describe("installKind / updateCommand", () => {
  it("detects a Homebrew install from its Cellar/homebrew path", () => {
    expect(installKind("/opt/homebrew/Cellar/ambient-code/0.6.0/libexec/bin/ambient")).toBe("brew");
    expect(installKind("/opt/homebrew/bin/ambient")).toBe("brew");
    expect(installKind("/home/linuxbrew/.linuxbrew/bin/ambient")).toBe("brew");
  });

  it("treats a repo/dev build path as a source install", () => {
    expect(installKind("/Users/alice/ambient-cli/packages/cli/dist/amb.js")).toBe("source");
    expect(installKind("/Users/alice/.local/bin/ambient")).toBe("source");
  });

  it("updateCommand matches the install kind", () => {
    expect(updateCommand("brew")).toBe("brew upgrade ambient-code");
    expect(updateCommand("source")).toContain("./scripts/install.sh");
  });
});
