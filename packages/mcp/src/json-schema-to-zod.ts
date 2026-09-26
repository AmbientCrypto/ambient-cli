import { z } from "zod";

/**
 * A bounded, best-effort JSON-Schema → Zod converter for MCP tool `inputSchema`. MCP tools advertise their
 * parameters as JSON Schema; the runtime + OpenAI wire want a Zod schema (so the model SEES the params). This
 * covers the common subset MCP servers actually emit (object/string/number/integer/boolean/array/enum, with
 * `required` + `description`); anything unrecognized degrades to a permissive value rather than throwing, and
 * recursion is depth-bounded so a pathological schema can't blow the stack.
 */

const MAX_DEPTH = 8;
/** A single parameter description is UNTRUSTED server text that lands in the model's tool schema / prompt —
 * flatten it to one line and bound it so it can't smuggle a multi-line injection payload. */
const MAX_DESCRIPTION = 500;

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  [k: string]: unknown;
};

/** Collapse newlines/runs of whitespace to single spaces and cap length — the same treatment the top-level
 *  tool description gets in to-tool.ts, applied to EVERY nested property description the converter preserves. */
function sanitizeDescription(s: string): string {
  const flat = s
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat;
}

function describe(schema: z.ZodTypeAny, s: JsonSchema): z.ZodTypeAny {
  if (typeof s.description !== "string" || s.description.length === 0) return schema;
  const clean = sanitizeDescription(s.description);
  return clean.length > 0 ? schema.describe(clean) : schema;
}

function convert(schema: JsonSchema | undefined, depth: number): z.ZodTypeAny {
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH) return z.unknown();

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const strings = schema.enum.filter((v): v is string => typeof v === "string");
    if (strings.length === schema.enum.length && strings.length > 0) {
      return describe(z.enum(strings as [string, ...string[]]), schema);
    }
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string":
      return describe(z.string(), schema);
    case "number":
    case "integer":
      return describe(z.number(), schema);
    case "boolean":
      return describe(z.boolean(), schema);
    case "array":
      return describe(z.array(convert(schema.items, depth + 1)), schema);
    case "object":
      return describe(convertObject(schema, depth), schema);
    default:
      // No/unknown type but it has properties ⇒ treat as an object; else accept anything.
      return schema.properties ? convertObject(schema, depth) : describe(z.unknown(), schema);
  }
}

function convertObject(schema: JsonSchema, depth: number): z.ZodTypeAny {
  const props = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(props)) {
    const inner = convert(propSchema, depth + 1);
    shape[key] = required.has(key) ? inner : inner.optional();
  }
  // Passthrough: forward any extra keys the model sends to the MCP server (it is the real validator).
  return z.object(shape).passthrough();
}

/** Convert an MCP tool inputSchema (JSON Schema) to a Zod object schema. Always returns an object schema so
 *  the tool has named params; a missing/invalid schema becomes a permissive passthrough object. */
export function jsonSchemaToZod(input: unknown): z.ZodType {
  if (!input || typeof input !== "object") return z.object({}).passthrough();
  const zod = convert(input as JsonSchema, 0);
  // The tool's top-level params MUST be an object for the OpenAI function schema; wrap a non-object.
  return (zod instanceof z.ZodObject ? zod : z.object({}).passthrough()) as z.ZodType;
}
