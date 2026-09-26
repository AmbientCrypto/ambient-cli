import { z } from "zod";

/** Classified provider/tool error kinds. `cold` => fail over; `rate_limit` => backoff. */
export const AmbErrorKindSchema = z.enum([
  "cold",
  "rate_limit",
  "overflow",
  "bad_request",
  "auth",
  "transport",
  "tool",
  "cancelled",
]);
export type AmbErrorKind = z.infer<typeof AmbErrorKindSchema>;

export const AmbErrorSchema = z.object({
  kind: AmbErrorKindSchema,
  message: z.string(),
  retryable: z.boolean(),
  model: z.string().optional(),
  detail: z.unknown().optional(),
  /** Server-requested wait before retrying (from a `Retry-After` header), in milliseconds. */
  retryAfterMs: z.number().nonnegative().optional(),
});
export type AmbErrorData = z.infer<typeof AmbErrorSchema>;

export class AmbError extends Error {
  readonly kind: AmbErrorKind;
  readonly retryable: boolean;
  readonly model?: string;
  readonly detail?: unknown;
  readonly retryAfterMs?: number;

  constructor(data: AmbErrorData) {
    super(data.message);
    this.name = "AmbError";
    this.kind = data.kind;
    this.retryable = data.retryable;
    this.model = data.model;
    this.detail = data.detail;
    this.retryAfterMs = data.retryAfterMs;
  }
}
