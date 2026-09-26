import { type ToolDefinition, toJSONSchema } from "@amb/protocol";
import type { z } from "zod";

/**
 * Convert a tool definition into an OpenAI-compatible `tools[]` function entry.
 * Ambient speaks the OpenAI wire, so we emit standard `{type:"function", function:{...}}`.
 */
export function toOpenAITool(tool: ToolDefinition): {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
} {
  return {
    type: "function",
    function: {
      name: tool.manifest.name,
      description: tool.manifest.description,
      parameters: toJSONSchema(tool.inputSchema as z.ZodType),
    },
  };
}

export function toOpenAITools(tools: ToolDefinition[]): ReturnType<typeof toOpenAITool>[] {
  return tools.map(toOpenAITool);
}
