import { describe, expect, it } from "vitest";
import { isBlockedIp, parseIpv4, parseIpv6 } from "../src/net/ip-guard.js";

describe("parseIpv4", () => {
  it("parses valid dotted-quads and rejects malformed / leading-zero / out-of-range", () => {
    expect(parseIpv4("1.2.3.4")).toEqual([1, 2, 3, 4]);
    expect(parseIpv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4("01.2.3.4")).toBeNull(); // leading zero
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("a.b.c.d")).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("expands :: compression and embedded IPv4", () => {
    expect(parseIpv6("::1")?.slice(-1)).toEqual([1]);
    expect(parseIpv6("::")?.every((b) => b === 0)).toBe(true);
    // ::ffff:1.2.3.4 → last 4 bytes are the v4, bytes 10-11 are 0xff
    const mapped = parseIpv6("::ffff:1.2.3.4");
    expect(mapped?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    // full form
    expect(parseIpv6("2001:db8::1")?.slice(0, 2)).toEqual([0x20, 0x01]);
    // strips zone id
    expect(parseIpv6("fe80::1%en0")?.[0]).toBe(0xfe);
  });
  it("rejects malformed", () => {
    expect(parseIpv6("1.2.3.4")).toBeNull(); // no colon
    expect(parseIpv6("::ffff::1")).toBeNull(); // two ::
    expect(parseIpv6("gggg::1")).toBeNull();
  });
});

describe("isBlockedIp — blocks the SSRF-dangerous ranges", () => {
  const blocked = [
    "127.0.0.1", // loopback
    "0.0.0.0", // unspecified
    "10.0.0.1", // private
    "10.255.255.255",
    "172.16.0.1", // 172.16/12 low edge
    "172.31.255.255", // 172.16/12 high edge
    "192.168.1.1", // private
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "169.254.169.254", // AWS/GCP/Azure metadata — THE classic SSRF target
    "169.254.0.1", // link-local
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "255.255.255.255", // broadcast
    "::1", // v6 loopback
    "::", // v6 unspecified
    "fe80::1", // v6 link-local
    "fc00::1", // v6 ULA
    "fd00::1", // v6 ULA (fd is in fc00::/7)
    "ff02::1", // v6 multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback — must extract + re-check
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::ffff:7f00:1", // IPv4-mapped loopback in HEX groups (not dotted)
    "::7f00:1", // IPv4-COMPAT loopback (::127.0.0.1 normalizes here)
    "64:ff9b::a9fe:a9fe", // NAT64 well-known prefix embedding 169.254.169.254
    "64:ff9b::7f00:1", // NAT64 embedding 127.0.0.1
    "64:ff9b:1::a00:1", // NAT64 local-use (RFC 8215) embedding 10.0.0.1
    "fec0::1", // deprecated site-local
    "not-an-ip", // unparseable → fail closed
    "", // empty → fail closed
  ];
  for (const ip of blocked) {
    it(`blocks ${ip || "(empty)"}`, () => expect(isBlockedIp(ip)).toBe(true));
  }
});

describe("isBlockedIp — allows real public addresses", () => {
  const allowed = [
    "1.1.1.1", // Cloudflare
    "8.8.8.8", // Google DNS
    "140.82.112.3", // GitHub-ish
    "172.15.255.255", // just BELOW 172.16/12
    "172.32.0.1", // just ABOVE 172.16/12
    "100.63.255.255", // just below CGNAT 100.64/10
    "100.128.0.1", // just above CGNAT
    "169.253.0.1", // just below link-local
    "169.255.0.1", // just above link-local
    "192.167.0.1", // just below 192.168/16
    "192.169.0.1", // just above 192.168/16
    "223.255.255.255", // just below multicast
    "2606:4700:4700::1111", // Cloudflare v6
    "2001:4860:4860::8888", // Google v6
    "::ffff:1.1.1.1", // IPv4-mapped public → allowed
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
});
