import type { SessionUsage } from "./state.js";

/** "18.2k", "202k", "1.1M", "950". */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** /context: how full the current model's window is, when it will compact, and what the cache saved. */
export function contextReport(opts: {
  model?: string;
  window?: number;
  inUse?: number;
  compactsAt?: number;
  usage?: SessionUsage;
}): string {
  if (!opts.window) return "Context · nothing sent yet — send a message and try again";
  const lines = [`Context · ${opts.model ?? "current model"} · ${tokens(opts.window)} window`];
  if (opts.inUse !== undefined) {
    lines.push(`  in use        ${tokens(opts.inUse)} tokens (${pct(opts.inUse, opts.window)}%)`);
  }
  if (opts.compactsAt !== undefined) {
    lines.push(`  compacts at   about ${tokens(opts.compactsAt)} — or run /compact now`);
  }
  const u = opts.usage;
  if (u?.lastPromptTokens !== undefined) {
    const cached = u.lastCachedTokens ?? 0;
    lines.push(
      `  last request  ${tokens(u.lastPromptTokens)} sent${cached > 0 ? ` · ${tokens(cached)} from cache (${pct(cached, u.lastPromptTokens)}%)` : ""}`,
    );
  }
  return lines.join("\n");
}

/** /usage: token counts for this session's main conversation — never money. */
export function usageReport(usage: SessionUsage | undefined): string {
  if (!usage || usage.requests === 0) return "Usage · no requests yet this session";
  const cached = usage.cachedTokens > 0 ? ` (${tokens(usage.cachedTokens)} from cache)` : "";
  return [
    `Usage · this session · ${usage.requests} request${usage.requests === 1 ? "" : "s"} (main conversation; subagents and summaries are separate)`,
    `  sent       ${tokens(usage.promptTokens)} tokens${cached}`,
    `  received   ${tokens(usage.completionTokens)} tokens`,
  ].join("\n");
}
