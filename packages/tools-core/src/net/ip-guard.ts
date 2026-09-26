/**
 * SSRF IP block-list — the security core of `web_fetch`. `isBlockedIp` returns true for any address a
 * user-authorized fetch must NEVER reach: loopback, private, CGNAT, link-local (incl. the cloud metadata
 * endpoint 169.254.169.254), ULA, unspecified, multicast, and reserved ranges — across IPv4, IPv6, and
 * IPv4-mapped IPv6. It FAILS CLOSED: an address we cannot parse is treated as blocked, never allowed.
 *
 * Pure + deterministic so it can be exhaustively tested against hand-verified CIDR membership.
 */

/** Parse a strict dotted-quad IPv4 into 4 octets, or null. Rejects leading zeros / out-of-range / wrong shape. */
export function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === "0") return null; // no leading zeros (avoid octal ambiguity)
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  const [a, b, c, d] = out;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

/** Expand an IPv6 string (with optional `::` and trailing embedded IPv4) into 16 bytes, or null. */
export function parseIpv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  // Strip a zone id (fe80::1%en0) — the address before % is what we vet.
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  if (!s.includes(":")) return null;

  // Normalize a trailing embedded IPv4 (::ffff:1.2.3.4) into its two equivalent hex groups so the rest of
  // the parse is uniform (the v4's 4 bytes = the last 2 groups, in the correct position after zero-fill).
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (!v4) return null;
    const g1 = ((v4[0] << 8) | v4[1]).toString(16);
    const g2 = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${g1}:${g2}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null; // at most one "::"
  const groupsToBytes = (grp: string[]): number[] | null => {
    const bytes: number[] = [];
    for (const g of grp) {
      if (g === "") return null;
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      const n = Number.parseInt(g, 16);
      bytes.push((n >> 8) & 0xff, n & 0xff);
    }
    return bytes;
  };

  if (halves.length === 2) {
    const h0 = halves[0] ?? "";
    const h1 = halves[1] ?? "";
    const head = groupsToBytes(h0 === "" ? [] : h0.split(":"));
    const tail = groupsToBytes(h1 === "" ? [] : h1.split(":"));
    if (head === null || tail === null) return null;
    const total = head.length + tail.length;
    if (total > 16) return null;
    return [...head, ...new Array(16 - total).fill(0), ...tail];
  }
  const g = s === "" ? [] : s.split(":");
  const bytes = groupsToBytes(g);
  if (bytes === null || bytes.length !== 16) return null; // no "::" ⇒ exactly 8 groups (16 bytes)
  return bytes;
}

function blockedV4(a: number, b: number, _c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0 && _c === 0) return true; // 192.0.0/24 IETF protocol
  if (a === 192 && b === 0 && _c === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && _c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && _c === 113) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // multicast 224/4
  if (a >= 240) return true; // 240/4 reserved incl. 255.255.255.255 broadcast
  return false;
}

function blockedV6(bytes: number[]): boolean {
  const g = (i: number): number => bytes[i] ?? 0; // callers pass a 16-byte array; ?? 0 satisfies the type
  const allZeroExceptLast = bytes.slice(0, 15).every((x) => x === 0);
  if (allZeroExceptLast && g(15) === 0) return true; // :: unspecified
  if (allZeroExceptLast && g(15) === 1) return true; // ::1 loopback
  // IPv4-mapped ::ffff:a.b.c.d  and deprecated IPv4-compatible ::a.b.c.d — re-check the embedded v4.
  const first10Zero = bytes.slice(0, 10).every((x) => x === 0);
  if (first10Zero && g(10) === 0xff && g(11) === 0xff) {
    return blockedV4(g(12), g(13), g(14), g(15));
  }
  if (bytes.slice(0, 12).every((x) => x === 0) && (g(12) !== 0 || g(13) !== 0)) {
    return blockedV4(g(12), g(13), g(14), g(15)); // ::a.b.c.d compat
  }
  // NAT64 (RFC 6052 well-known 64:ff9b::/96 + RFC 8215 local-use 64:ff9b:1::/48) embeds an IPv4 in the low
  // bits and, on a host with a NAT64 gateway, routes to it. No legitimate web_fetch target is a NAT64
  // literal — block the whole prefix (both share the first 32 bits 0064:ff9b).
  if (g(0) === 0x00 && g(1) === 0x64 && g(2) === 0xff && g(3) === 0x9b) return true;
  if ((g(0) & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (g(0) === 0xfe && (g(1) & 0x80) === 0x80) return true; // fe80::/9 — link-local + deprecated site-local
  if (g(0) === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** True if the literal IP is one a user-authorized fetch must never reach. Unparseable ⇒ blocked (fail closed). */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return blockedV4(v4[0], v4[1], v4[2], v4[3]);
  const v6 = parseIpv6(ip);
  if (v6) return blockedV6(v6);
  return true; // cannot understand it → do not allow it
}
