import type { ToolDefinition } from "@amb/protocol";
import { type ToolRegistry, createBuiltinRegistry } from "@amb/tools-core";

export interface RegistryDeps {
  /** MCP-provided tools (namespaced mcp__server__tool); [] when no servers are configured. */
  mcpTools?: ToolDefinition[];
  /** The `subagent` delegation tool — omitted from a CHILD registry so subagents can't spawn (depth cap). */
  subagent?: ToolDefinition;
  /** Any other externally-provided tools. */
  extra?: ToolDefinition[];
}

/**
 * Build the tool registry the CLI injects into `Agent` — the 17 builtins plus any MCP/subagent/extra tools.
 * This is the single composition point at the edge (the runtime stays pure). `register` throws on a duplicate
 * name; MCP names are pre-namespaced (`mcp__…`) so they never collide with builtins.
 */
export function buildRegistry(deps: RegistryDeps = {}): ToolRegistry {
  const reg = createBuiltinRegistry();
  for (const t of deps.mcpTools ?? []) reg.register(t);
  for (const t of deps.extra ?? []) reg.register(t);
  if (deps.subagent) reg.register(deps.subagent);
  return reg;
}
