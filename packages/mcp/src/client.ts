import { z } from "zod";
import { type JsonRpcClient, JsonRpcError } from "./jsonrpc.js";

/** The MCP protocol version we speak (JSON-RPC 2.0 over stdio, newline-delimited). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Bounds on what an UNTRUSTED server can make us hold in memory before the runtime's own result cap runs. */
const MAX_TOOLS = 512; // tools/list is truncated to this many
const MAX_CONTENT_PARTS = 256; // tools/call content parts kept
const MAX_RESULT_CHARS = 262_144; // total flattened tool-result text (256 KiB) the model could ever see
/** The handshake + tools/list must be quick; a tool CALL may legitimately run much longer (matches the tool
 *  manifest's maximumMs), so the two policies are separate — one slow tool must not be capped at the init budget. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

const McpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  // MCP tool annotations (advisory hints). `readOnlyHint:true` lets us map the tool to read-only effects.
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});
export type McpTool = z.infer<typeof McpToolSchema>;

const ListToolsResult = z.object({ tools: z.array(McpToolSchema).default([]) });

// A tool result is a list of content parts (text/image/…) + an optional error flag.
const CallToolResult = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
    .default([]),
  isError: z.boolean().optional(),
});
export type CallToolResult = z.infer<typeof CallToolResult>;

/**
 * A thin MCP client over a JSON-RPC endpoint: the `initialize` handshake, tool discovery, and tool calls.
 * Every response is validated with Zod at the boundary (an untrusted server can't hand us a malformed shape
 * the rest of the app then trusts). v1 supports tools only (resources/prompts deferred).
 */
const ResourceSchema = z.object({
  uri: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type McpResource = z.infer<typeof ResourceSchema>;
const ListResourcesResult = z.object({ resources: z.array(ResourceSchema).default([]) });
const ReadResourceResult = z.object({
  contents: z
    .array(
      z
        .object({
          uri: z.string().optional(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional(),
        })
        .passthrough(),
    )
    .default([]),
});

const PromptSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  arguments: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type McpPrompt = z.infer<typeof PromptSchema>;
const ListPromptsResult = z.object({ prompts: z.array(PromptSchema).default([]) });
const GetPromptResult = z.object({
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
      }),
    )
    .default([]),
});

/** What a server said it can do in the handshake. */
export interface McpCapabilities {
  tools?: { listChanged?: boolean };
  resources?: unknown;
  prompts?: unknown;
}

const MAX_RESOURCES = 512;
const MAX_PROMPTS = 256;

export class McpClient {
  private readonly callTimeoutMs: number;
  /** Filled in by initialize(). */
  capabilities: McpCapabilities = {};
  constructor(
    private readonly rpc: JsonRpcClient,
    opts: { callTimeoutMs?: number } = {},
  ) {
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** Perform the MCP handshake. Must complete before listTools/callTool. */
  async initialize(): Promise<void> {
    const result = (await this.rpc.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ambient-cli", version: "0.1.0" },
    })) as { capabilities?: unknown } | undefined;
    const caps = result?.capabilities;
    this.capabilities = caps && typeof caps === "object" ? (caps as McpCapabilities) : {};
    this.rpc.notify("notifications/initialized");
  }

  /** Called when the server says its tool list changed. */
  onToolsChanged(cb: () => void): void {
    this.rpc.onNotification((method) => {
      if (method === "notifications/tools/list_changed") cb();
    });
  }

  async listResources(): Promise<McpResource[]> {
    const raw = boundArrayField(
      await this.rpc.request("resources/list", {}),
      "resources",
      MAX_RESOURCES,
    );
    const parsed = ListResourcesResult.safeParse(raw);
    if (!parsed.success)
      throw new JsonRpcError(`malformed resources/list: ${parsed.error.message}`);
    return parsed.data.resources;
  }

  /** A resource's contents as bounded text (binary parts are described, not included). */
  async readResource(uri: string): Promise<string> {
    const raw = boundArrayField(
      await this.rpc.request("resources/read", { uri }, this.callTimeoutMs),
      "contents",
      MAX_CONTENT_PARTS,
    );
    const parsed = ReadResourceResult.safeParse(raw);
    if (!parsed.success)
      throw new JsonRpcError(`malformed resources/read: ${parsed.error.message}`);
    const text = parsed.data.contents
      .map((c) =>
        typeof c.text === "string"
          ? c.text
          : `[binary ${c.mimeType ?? "data"}, ${Math.floor(((c.blob ?? "").length * 3) / 4)} bytes]`,
      )
      .join("\n")
      .trim();
    return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const raw = boundArrayField(await this.rpc.request("prompts/list", {}), "prompts", MAX_PROMPTS);
    const parsed = ListPromptsResult.safeParse(raw);
    if (!parsed.success) throw new JsonRpcError(`malformed prompts/list: ${parsed.error.message}`);
    return parsed.data.prompts;
  }

  /** A prompt's messages flattened to text (what gets sent as the user's task). */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const raw = boundArrayField(
      await this.rpc.request("prompts/get", { name, arguments: args }, this.callTimeoutMs),
      "messages",
      MAX_CONTENT_PARTS,
    );
    const parsed = GetPromptResult.safeParse(raw);
    if (!parsed.success) throw new JsonRpcError(`malformed prompts/get: ${parsed.error.message}`);
    const text = parsed.data.messages
      .map((m) => (typeof m.content.text === "string" ? m.content.text : `[${m.content.type}]`))
      .join("\n\n")
      .trim();
    return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
  }

  /** Discover the server's tools (count-bounded BEFORE validation, then validated). */
  async listTools(): Promise<McpTool[]> {
    const raw = boundArrayField(await this.rpc.request("tools/list", {}), "tools", MAX_TOOLS);
    const parsed = ListToolsResult.safeParse(raw);
    if (!parsed.success) throw new JsonRpcError(`malformed tools/list: ${parsed.error.message}`);
    return parsed.data.tools;
  }

  /** Invoke a tool by name with arguments; returns the count-bounded (BEFORE validation), validated result. */
  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    // Bound the content-part array on the RAW response, before Zod clones every part (untrusted server).
    const raw = boundArrayField(
      await this.rpc.request("tools/call", { name, arguments: args ?? {} }, this.callTimeoutMs),
      "content",
      MAX_CONTENT_PARTS,
    );
    const parsed = CallToolResult.safeParse(raw);
    if (!parsed.success)
      throw new JsonRpcError(`malformed tools/call result: ${parsed.error.message}`);
    return parsed.data;
  }

  close(): void {
    this.rpc.close();
  }
}

/** If `raw.<field>` is an array longer than `max`, return a shallow copy truncated to `max` — applied to the
 *  UNTRUSTED response BEFORE schema validation so Zod never parses/clones an unbounded array. */
function boundArrayField(raw: unknown, field: string, max: number): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const arr = o[field];
  return Array.isArray(arr) && arr.length > max ? { ...o, [field]: arr.slice(0, max) } : raw;
}

/** Flatten an MCP call result's content parts into a single, length-bounded text blob (what the model sees).
 *  Trim (drop outer whitespace) BEFORE the cap so leading padding never displaces real content, then bound.
 *  The input is already frame-bounded (LineFramer cap) + part-count-bounded (boundArrayField), so building the
 *  joined string here is a bounded transient — correctness (exact prior semantics) beats a micro-optimization. */
export function resultToText(r: CallToolResult): string {
  const joined = r.content
    .map((c) => (typeof c.text === "string" ? c.text : `[${c.type}]`))
    .join("\n")
    .trim();
  const text = joined.length > MAX_RESULT_CHARS ? `${joined.slice(0, MAX_RESULT_CHARS)}…` : joined;
  return r.isError ? `tool error: ${text || "(no detail)"}` : text;
}
