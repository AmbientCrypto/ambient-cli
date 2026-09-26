import { isBlockedIp, parseIpv4, parseIpv6 } from "./ip-guard.js";

/** Resolve a hostname to its addresses. Injectable so the tool + tests never depend on real DNS. */
export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

/** URL that failed an SSRF gate. Distinct type so the tool can surface a clean, non-leaky message. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/** Parse + vet a URL's shape: only http/https, and no embedded credentials (a common SSRF/phishing vector). */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`unsupported scheme '${url.protocol}' (only http/https)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new BlockedUrlError("URLs with embedded credentials are refused");
  }
  return url;
}

/** URL.hostname keeps brackets around IPv6 literals; strip them so the IP checks see the bare address. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

/**
 * Enforce that a host does not point at an internal address, and RETURN the vetted addresses so the caller
 * can PIN them into the actual connection (closing the DNS-rebind window: the guard's lookup and fetch's
 * lookup would otherwise resolve independently). If it's an IP literal we check it directly; otherwise we
 * RESOLVE it and reject if ANY resolved address is blocked — what stops a public hostname that resolves to
 * 169.254.169.254 (the cloud-metadata SSRF). Throws BlockedUrlError on violation.
 */
export async function assertHostAllowed(
  hostname: string,
  lookup: LookupFn,
): Promise<{ address: string }[]> {
  const host = bareHost(hostname);
  if (host === "") throw new BlockedUrlError("empty host");
  if (isIpLiteral(host)) {
    if (isBlockedIp(host)) throw new BlockedUrlError(`host resolves to a blocked address: ${host}`);
    return [{ address: host }]; // already an IP — nothing to rebind
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host);
  } catch {
    throw new BlockedUrlError(`could not resolve host: ${host}`);
  }
  if (addrs.length === 0) throw new BlockedUrlError(`host did not resolve: ${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new BlockedUrlError(`host ${host} resolves to a blocked address: ${a.address}`);
    }
  }
  return addrs;
}
