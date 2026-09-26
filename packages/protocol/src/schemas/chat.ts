import { z } from "zod";

/**
 * OpenAI-compatible /v1/chat/completions wire schemas. Clean-room from ambient-code-bridge (MIT).
 * These freeze the transport contract so conformance tests catch provider/SDK drift.
 */

export const ChatRoleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Reasoning-effort levels the OpenAI-compatible API accepts for reasoning-capable models. */
/** Wire values for `reasoning_effort`. Ambient serves none/high/max; low/medium stay valid for compatibility. */
export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  // Sent only for models whose catalog advertises the `reasoning` feature. The API is lenient (ignores it
  // where unsupported), so it's safe + forward-compatible as models add real effort control.
  reasoning_effort: ReasoningEffortSchema.optional(),
});
export type ChatRequestWire = z.infer<typeof ChatRequestSchema>;

export const UsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  /** Prompt-cache detail: how many prompt tokens were served from the provider's cache. */
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().nullable().optional() })
    .nullable()
    .optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

const ToolCallDeltaSchema = z.object({
  index: z.number().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
});

/** One SSE chunk (chat.completion.chunk). Reasoning may arrive under several key names. */
export const ChatChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            role: z.string().optional(),
            content: z.string().nullable().optional(),
            reasoning: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional(),
            reasoning_text: z.string().nullable().optional(),
            tool_calls: z.array(ToolCallDeltaSchema).optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: UsageSchema.nullable().optional(),
});
export type ChatChunk = z.infer<typeof ChatChunkSchema>;

/** Settled non-stream chat.completion (also the shape we reconstruct from a stream). */
export const ChatCompletionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(
    z.object({
      message: z
        .object({
          role: z.string().optional(),
          content: z.string().nullable().optional(),
          tool_calls: z.array(z.unknown()).optional(),
        })
        .optional(),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: UsageSchema.optional(),
});
export type ChatCompletion = z.infer<typeof ChatCompletionSchema>;
