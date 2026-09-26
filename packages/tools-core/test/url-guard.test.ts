import { describe, expect, it } from "vitest";
import { BlockedUrlError, assertFetchableUrl, assertHostAllowed } from "../src/net/url-guard.js";

describe("assertFetchableUrl", () => {
  it("accepts http/https and returns the parsed URL", () => {
    expect(assertFetchableUrl("https://example.com/a").hostname).toBe("example.com");
    expect(assertFetchableUrl("http://example.com").protocol).toBe("http:");
  });
  it("rejects non-http(s) schemes", () => {
    for (const u of ["file:///etc/passwd", "ftp://host/x", "gopher://h", "data:text/html,x"]) {
      expect(() => assertFetchableUrl(u)).toThrow(BlockedUrlError);
    }
  });
  it("rejects embedded credentials and garbage", () => {
    expect(() => assertFetchableUrl("https://user:pass@example.com")).toThrow(/credentials/);
    expect(() => assertFetchableUrl("not a url")).toThrow(BlockedUrlError);
  });
});

describe("assertHostAllowed", () => {
  const lookupTo =
    (...addrs: string[]) =>
    async () =>
      addrs.map((address) => ({ address }));

  it("allows a host that resolves to a public address and RETURNS the vetted addrs (for IP-pinning)", async () => {
    await expect(assertHostAllowed("example.com", lookupTo("1.1.1.1"))).resolves.toEqual([
      { address: "1.1.1.1" },
    ]);
  });
  it("blocks a host that resolves to the cloud-metadata IP (the DNS-based SSRF)", async () => {
    await expect(
      assertHostAllowed("evil.example.com", lookupTo("169.254.169.254")),
    ).rejects.toThrow(/blocked address/);
  });
  it("blocks when ANY resolved address is internal (mixed A records)", async () => {
    await expect(
      assertHostAllowed("mixed.example.com", lookupTo("1.1.1.1", "10.0.0.5")),
    ).rejects.toThrow(BlockedUrlError);
  });
  it("checks an IP literal directly without DNS", async () => {
    const never: () => Promise<never> = async () => {
      throw new Error("lookup must not be called for a literal");
    };
    await expect(assertHostAllowed("127.0.0.1", never)).rejects.toThrow(/blocked/);
    await expect(assertHostAllowed("[::1]", never)).rejects.toThrow(/blocked/);
    await expect(assertHostAllowed("8.8.8.8", never)).resolves.toEqual([{ address: "8.8.8.8" }]);
  });
  it("rejects an unresolvable host and an empty resolution", async () => {
    const boom: LookupThrow = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertHostAllowed("nope.invalid", boom)).rejects.toThrow(/could not resolve/);
    await expect(assertHostAllowed("empty.invalid", async () => [])).rejects.toThrow(
      /did not resolve/,
    );
  });
});

type LookupThrow = () => Promise<{ address: string }[]>;
