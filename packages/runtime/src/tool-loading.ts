import { estimateTokens } from "@amb/context";
import type { ToolDefinition } from "@amb/protocol";
import { toOpenAITools } from "@amb/tools-core";
import { z } from "zod";

/**
 * On-demand tools. Connected MCP servers can bring hundreds of tools; sending every schema with every request
 * can take more room than a small model has. When they don't all fit the model's tool budget, the model sees
 * a short index of what's available and loads the tools it needs with `load_tools`; the loaded tools are then
 * offered like any other (same permissions — the model calls the real tool).
 */
export const LOAD_TOOLS = "load_tools";

/** Tools that may be loaded on demand instead of up front (from MCP servers). */
export const isDeferrable = (name: string) => name.startsWith("mcp__");

/** Most tools one `load_tools` call adds. */
const MAX_PER_LOAD = 8;

const schemaTokens = (tools: readonly ToolDefinition[]) =>
  tools.length === 0 ? 0 : estimateTokens(JSON.stringify(toOpenAITools([...tools])));

export class ToolLoader {
  /** Loaded deferrable tools, oldest first. */
  private readonly loaded: string[] = [];
  /** Bumped whenever the loaded set changes, so the caller knows to rebuild the tool list. */
  version = 0;

  constructor(
    private readonly deferrable: readonly ToolDefinition[],
    private readonly budget: () => number,
  ) {}

  /** True when the deferrable tools don't all fit the budget, so they're loaded on demand. */
  get onDemand(): boolean {
    return schemaTokens(this.deferrable) > this.budget();
  }

  /** The deferrable tools to offer right now: all of them when they fit, else the loaded ones that fit. */
  offered(): ToolDefinition[] {
    if (!this.onDemand) return [...this.deferrable];
    const byName = new Map(this.deferrable.map((t) => [t.manifest.name, t]));
    const out: ToolDefinition[] = [];
    let used = 0;
    // Newest first, so after a switch to a smaller model the most recently needed tools stay.
    for (const name of [...this.loaded].reverse()) {
      const t = byName.get(name);
      if (!t) continue;
      const cost = schemaTokens([t]);
      if (used + cost > this.budget()) continue;
      used += cost;
      out.push(t);
    }
    return out;
  }

  /** Find the tools that best match `query` and load them (within the budget). */
  load(query: string): { loaded: ToolDefinition[]; alreadyLoaded: string[] } {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    const scored = this.deferrable
      .map((t) => {
        const hay = `${t.manifest.name} ${t.manifest.description ?? ""}`.toLowerCase();
        const name = t.manifest.name.toLowerCase();
        const score = words.reduce(
          (s, w) => s + (name.includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0),
          0,
        );
        return { t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PER_LOAD)
      .map((x) => x.t);
    const alreadyLoaded: string[] = [];
    const loaded: ToolDefinition[] = [];
    for (const t of scored) {
      const name = t.manifest.name;
      const at = this.loaded.indexOf(name);
      if (at >= 0) {
        alreadyLoaded.push(name);
        this.loaded.splice(at, 1); // refresh its place as most recently needed
      } else {
        loaded.push(t);
      }
      this.loaded.push(name);
    }
    if (scored.length > 0) this.version++;
    return { loaded, alreadyLoaded };
  }

  /** "chrome-devtools (30), playwright (25), …" — what can be loaded, by server. */
  index(): string {
    const counts = new Map<string, number>();
    for (const t of this.deferrable) {
      const server = t.manifest.name.split("__")[1] ?? "other";
      counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    return [...counts].map(([s, n]) => `${s} (${n})`).join(", ");
  }
}

const Input = z.object({
  query: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "What you need to do, in a few words — e.g. 'take a browser screenshot' or 'jira issue'",
    ),
});
const Output = z.object({
  loaded: z.array(z.object({ name: z.string(), description: z.string() })),
  note: z.string(),
});

export function makeLoadToolsTool(
  loader: ToolLoader,
): ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    manifest: {
      name: LOAD_TOOLS,
      version: "1",
      description: `Load more tools on demand. Available from connected servers: ${loader.index()}. Describe what you need; the best-matching tools become available from your next step.`,
      effects: ["read"],
      idempotency: "pure",
      parallelSafe: true,
      resumability: "replay",
      timeoutPolicy: { idleMs: 5_000, maximumMs: 10_000 },
    },
    inputSchema: Input,
    outputSchema: Output,
    async execute(input) {
      const { loaded, alreadyLoaded } = loader.load(input.query);
      const all = [...loaded.map((t) => t.manifest.name), ...alreadyLoaded];
      const described = loaded.map((t) => ({
        name: t.manifest.name,
        description: (t.manifest.description ?? "").slice(0, 300),
      }));
      return {
        loaded: described,
        note:
          all.length === 0
            ? `No tool matched "${input.query}". Try other words; available servers: ${loader.index()}.`
            : `Available from your next step: ${all.join(", ")}.`,
      };
    },
  };
}
