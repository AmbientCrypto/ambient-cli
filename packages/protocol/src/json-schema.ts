import { z } from "zod";

/**
 * Convert a Zod schema to a JSON Schema object suitable for an OpenAI `tools[].function.parameters`.
 * Wraps Zod v4's built-in converter so tool authors don't depend on zod internals directly.
 */
export function toJSONSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
