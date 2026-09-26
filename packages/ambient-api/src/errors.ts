import { AmbError } from "@amb/protocol";
import { classify429, isContextOverflowError } from "@amb/reliability";

/**
 * Map an HTTP failure from Ambient into a classified AmbError. The 429 split (cold vs rate-limit) and
 * the 400 overflow-vs-param distinction are the two that matter most for the agent's recovery path.
 */
export function classifyHttpError(
  status: number,
  body: string,
  opts: { model?: string; hasImage?: boolean; retryAfterMs?: number } = {},
): AmbError {
  const model = opts.model;
  const retryAfter = opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {};
  if (status === 401 || status === 403) {
    return new AmbError({
      kind: "auth",
      message: "Ambient authentication failed — check your API key.",
      retryable: false,
      model,
      detail: body,
    });
  }
  if (status === 429) {
    const kind = classify429(body);
    return new AmbError({
      kind,
      message:
        kind === "cold"
          ? "No workers are currently available for this model (cold)."
          : "Rate limited by Ambient.",
      retryable: kind !== "cold",
      model,
      detail: body,
      ...retryAfter,
    });
  }
  if (status === 400 && isContextOverflowError(body, { hasImage: opts.hasImage })) {
    return new AmbError({
      kind: "overflow",
      message: "Prompt exceeds the model's context window.",
      retryable: true,
      model,
      detail: body,
    });
  }
  if (status === 400) {
    const reason = serverReason(body);
    return new AmbError({
      kind: "bad_request",
      message: reason ? `Ambient rejected the request: ${reason}` : "Bad request to Ambient.",
      retryable: false,
      model,
      detail: body,
    });
  }
  if (status === 404) {
    // The chat endpoint URL is fixed and correct, so a 404 means the requested MODEL isn't available at the
    // gateway right now (a decentralized fleet drops/rotates workers). Make it RETRYABLE so the run FAILS OVER
    // to a warm model instead of hard-dying with "Unexpected Ambient status 404" — the user saw every
    // queued/steered follow-up die this way. If the whole endpoint were wrong, ALL runs would 404 and the
    // bounded failovers still surface a clear terminal error.
    return new AmbError({
      kind: "transport",
      message: `Model ${model ?? "?"} is not available right now (404) — trying another.`,
      retryable: true,
      model,
      detail: body,
    });
  }
  if (status >= 500) {
    return new AmbError({
      kind: "transport",
      message: `Ambient upstream error (${status}).`,
      retryable: true,
      model,
      detail: body,
      ...retryAfter,
    });
  }
  return new AmbError({
    kind: "transport",
    message: `Unexpected Ambient status ${status}.`,
    retryable: false,
    model,
    detail: body,
  });
}

/** The server's own explanation from an error body (`{"error":{"message":…}}` or plain text), one line. */
export function serverReason(body: string, depth = 0): string | undefined {
  let text = body;
  // A streamed error can follow keep-alive comment lines (`: keep-alive`): read the JSON after them.
  const json = body.slice(Math.max(0, body.indexOf("{")));
  try {
    const parsed = JSON.parse(json) as {
      error?: { message?: unknown; details?: unknown } | string;
      message?: unknown;
    };
    const err = typeof parsed.error === "object" ? parsed.error : undefined;
    // A gateway may wrap the model server's own error in `details` — that inner one says what went wrong.
    const inner =
      depth < 2 && typeof err?.details === "string"
        ? serverReason(err.details, depth + 1)
        : undefined;
    const m = inner ?? (err ? err.message : (parsed.error ?? parsed.message));
    if (typeof m === "string") text = m;
  } catch {
    // not JSON: use the text as it is
  }
  const line = text.replace(/\s+/g, " ").trim();
  return line ? (line.length > 300 ? `${line.slice(0, 299)}…` : line) : undefined;
}
