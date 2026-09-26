/**
 * Ambient endpoint config + host-pinning. Clean-room from ambient-code-bridge/bin/ambient (MIT).
 *
 * Security: the base URL must be HTTPS and pinned to *.ambient.xyz. Only loopback may relax this,
 * and only when AMBIENT_ALLOW_INSECURE=1 is set explicitly.
 */

export const DEFAULT_BASE_URL = "https://api.ambient.xyz";
export const KEYS_URL = "https://app.ambient.xyz/keys";
export const KEYCHAIN_SERVICE = "ambient.xyz";

export interface AmbientConfig {
  baseUrl: string;
  apiKey?: string;
}

/** Minimal fetch signature so tests can inject a mock. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ALLOWED_HOST = /(^|\.)ambient\.xyz$/i;

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function normalizeBaseUrl(raw: string, opts: { allowInsecure?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid Ambient base URL: ${raw}`);
  }
  const loopback = isLoopback(u.hostname);
  const relax = opts.allowInsecure === true && loopback;
  if (u.protocol !== "https:" && !relax) {
    throw new Error(
      `Ambient base URL must be https:// (got ${u.protocol}//). Set AMBIENT_ALLOW_INSECURE=1 for loopback only.`,
    );
  }
  if (!ALLOWED_HOST.test(u.hostname) && !relax) {
    throw new Error(`Ambient base URL host must be *.ambient.xyz (got ${u.hostname}).`);
  }
  return `${u.protocol}//${u.host}`;
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): AmbientConfig {
  const raw = env.AMBIENT_API_URL ?? env.AMBIENT_BASE_URL ?? DEFAULT_BASE_URL;
  const allowInsecure = env.AMBIENT_ALLOW_INSECURE === "1";
  const baseUrl = normalizeBaseUrl(raw, { allowInsecure });
  return { baseUrl, apiKey: env.AMBIENT_API_KEY };
}

export const catalogUrl = (c: Pick<AmbientConfig, "baseUrl">): string => `${c.baseUrl}/v1/models`;
export const chatUrl = (c: Pick<AmbientConfig, "baseUrl">): string =>
  `${c.baseUrl}/v1/chat/completions`;

export function authHeaders(c: AmbientConfig): Record<string, string> {
  return c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {};
}
