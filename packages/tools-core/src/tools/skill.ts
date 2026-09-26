import { loadSkill } from "@amb/context";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveInWorkspace } from "../paths.js";

const Input = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("A skill name (from the skill index or from `search_skills` results)"),
});
const Output = z.object({
  name: z.string(),
  found: z.boolean(),
  body: z.string(),
});

/**
 * The `skill` tool — progressive disclosure. The model sees only a lightweight catalog (name + description)
 * in its context; when a skill is relevant it calls this to pull in the FULL instructions on demand. Read-only
 * (never prompts). The returned body is UNTRUSTED reference material — the model should use it as guidance,
 * not as commands that change what it's allowed to do (agent-trap defense).
 */
export const skillTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "skill",
    version: "1",
    description:
      "Load the full instructions for a named skill. Call this when a skill (from the index or a `search_skills` result) is relevant; it returns the skill's detailed steps/reference. Read-only, no side effects.",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 5_000, maximumMs: 5_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const loaded = loadSkill(ctx.workspaceRoot, input.name);
    if (loaded === undefined) {
      return {
        name: input.name,
        found: false,
        body: `No skill named "${input.name}" was found. Use \`search_skills\` to find a valid skill name.`,
      };
    }
    // Surface the skill's own directory so the model can open the sidecar files a full Claude-style skill
    // bundle ships (scripts/, references/, templates the instructions refer to) — but ONLY when that dir is
    // actually reachable by `read`/`list`, which enforce the workspace boundary. A skill under ~/.claude/skills
    // or a plugin dir is outside the workspace, so those tools would refuse it and the hint would be a lie;
    // resolveInWorkspace throws for exactly those paths (the same boundary read/list use), keeping this honest.
    // Built-in skills have no dir (body lives in code).
    let reachableDir: string | undefined;
    if (loaded.dir) {
      try {
        resolveInWorkspace(ctx.workspaceRoot, loaded.dir);
        reachableDir = loaded.dir;
      } catch {
        // A skill installed outside the project (~/.claude/skills, a plugin): loading it grants read-only
        // access to its own folder for the rest of the run, so its bundled files can be opened.
        if (ctx.readRoots) {
          ctx.readRoots.add(loaded.dir);
          reachableDir = loaded.dir;
        }
      }
    }
    const body = reachableDir
      ? `${loaded.body}\n\n---\nThis skill's files are in: ${reachableDir}\nIf the instructions above reference bundled files (e.g. scripts/, references/, templates), open them from that directory with \`list\`/\`read\`.`
      : loaded.body;
    return { name: input.name, found: true, body };
  },
};
