import { describe, expect, it } from "vitest";
import { classifyHttpError } from "../src/index.js";

describe("classifyHttpError", () => {
  it("401/403 => auth (not retryable)", () => {
    expect(classifyHttpError(401, "unauthorized").kind).toBe("auth");
    expect(classifyHttpError(403, "forbidden").retryable).toBe(false);
  });
  it("429 splits cold (fail over) vs rate_limit (retry)", () => {
    const cold = classifyHttpError(429, "No workers are currently available");
    expect(cold.kind).toBe("cold");
    expect(cold.retryable).toBe(false);
    const rl = classifyHttpError(429, "rate limit exceeded");
    expect(rl.kind).toBe("rate_limit");
    expect(rl.retryable).toBe(true);
  });
  it("400 distinguishes overflow from param errors", () => {
    expect(classifyHttpError(400, "prompt is too long: 5 tokens > 4 maximum").kind).toBe(
      "overflow",
    );
    expect(classifyHttpError(400, "unsupported parameter: temperature").kind).toBe("bad_request");
  });
  it("5xx => transport (retryable)", () => {
    expect(classifyHttpError(503, "bad gateway").retryable).toBe(true);
  });
  it("404 => a RETRYABLE transport error so the run fails over to a warm model (not a hard die)", () => {
    const e = classifyHttpError(404, "model not found", { model: "z-ai/glm-5.2" });
    expect(e.kind).toBe("transport");
    expect(e.retryable).toBe(true); // → the failover engine substitutes instead of dying with "404"
    expect(e.message).toContain("glm-5.2");
  });
});

describe("network failures", () => {
  it("say what actually went wrong instead of a bare 'fetch failed'", async () => {
    const { describeNetworkFailure } = await import("../src/chat.js");
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(describeNetworkFailure(reset)).toBe(
      "network error reaching Ambient — the connection was reset",
    );
    const odd = Object.assign(new TypeError("fetch failed"), {
      cause: { message: "socket hang up" },
    });
    expect(describeNetworkFailure(odd)).toBe("network error reaching Ambient — socket hang up");
    expect(describeNetworkFailure(new Error("other"))).toBeUndefined();
    expect(describeNetworkFailure(new DOMException("aborted", "AbortError"))).toBeUndefined();
  });
  it("a refused connection surfaces as a retryable transport error", async () => {
    const { streamChatCompletion } = await import("../src/chat.js");
    const { AmbError } = await import("@amb/protocol");
    const failing = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const err = await streamChatCompletion(
      { baseUrl: "https://api.ambient.xyz", apiKey: "k" },
      { model: "m/x", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
      { fetch: failing as never },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbError);
    expect((err as InstanceType<typeof AmbError>).kind).toBe("transport");
    expect((err as InstanceType<typeof AmbError>).retryable).toBe(true);
    expect((err as Error).message).toContain("the connection was refused");
  });
});

describe("a rejected request says why", () => {
  it("shows the server's reason", async () => {
    const { classifyHttpError } = await import("../src/errors.js");
    const e = classifyHttpError(
      400,
      JSON.stringify({
        error: {
          message:
            "messages[3].role='system' is only supported before conversation messages for this model.",
        },
      }),
    );
    expect(e.kind).toBe("bad_request");
    expect(e.message).toBe(
      "Ambient rejected the request: messages[3].role='system' is only supported before conversation messages for this model.",
    );
    expect(classifyHttpError(400, "").message).toBe("Bad request to Ambient.");
  });

  it("reads the reason after stream keep-alive lines", async () => {
    const { classifyHttpError } = await import("../src/errors.js");
    const e = classifyHttpError(
      400,
      ': keep-alive\n\n{"error":{"message":"System message must be at the beginning.","type":"BadRequestError"}}',
    );
    expect(e.message).toBe(
      "Ambient rejected the request: System message must be at the beginning.",
    );
  });

  it("digs the model server's reason out of a gateway wrapper", async () => {
    const { serverReason } = await import("../src/errors.js");
    const body = JSON.stringify({
      error: {
        message: "Upstream request failed",
        type: "upstream_error",
        details: JSON.stringify({ error: { message: "System message must be at the beginning." } }),
      },
    });
    expect(serverReason(body)).toBe("System message must be at the beginning.");
  });
});
