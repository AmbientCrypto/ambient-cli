import { searchSkills } from "@amb/context";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";

const Input = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Keywords describing the task, to find matching skills (e.g. 'react testing', 'keychain')",
    ),
});
const Match = z.object({ name: z.string(), description: z.string() });
const Output = z.object({ matches: z.array(Match), count: z.number() });

/**
 * The `search_skills` tool — search-first progressive disclosure. Instead of every skill's description being
 * force-fed the prompt, the model searches its FULL skill library (its own + Claude/Codex/plugins) on demand
 * and gets back the relevant name+description matches; it then calls `skill` to load a chosen one's body.
 * Read-only. Matches are UNTRUSTED reference metadata, never instructions.
 */
export const searchSkillsTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "search_skills",
    version: "1",
    description:
      "Search your reusable skills by keyword and get back the matching skills (name + one-line description). Use this when a task might match a skill; then call `skill` with a name to load its full instructions. Read-only.",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 5_000, maximumMs: 5_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const hits = searchSkills(ctx.workspaceRoot, input.query);
    return {
      matches: hits.map((s) => ({ name: s.name, description: s.description })),
      count: hits.length,
    };
  },
};
