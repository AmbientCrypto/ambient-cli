import { AmbError } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { type FetchLike, streamChatCompletion } from "../src/index.js";

const config = { baseUrl: "https://api.ambient.xyz", apiKey: "k" };
const req = { model: "m/x", messages: [{ role: "user", content: "hi" }] };
const enc = new TextEncoder();
const chunk = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);

/** A fetch whose body emits the given frames with delays (ms before each), then optionally hangs forever. */
function scriptedFetch(frames: Array<[number, Uint8Array]>, hangAfter = false): FetchLike {
  return async (_url, init) => {
    const signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const onAbort = () => ctrl.error(new DOMException("aborted", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
        for (const [delay, bytes] of frames) {
          await new Promise((r) => setTimeout(r, delay));
          if (signal?.aborted) return;
          ctrl.enqueue(bytes);
        }
        if (!hangAfter) ctrl.close();
      },
    });
    return new Response(body, { status: 200 });
  };
}

describe("stream watchdog", () => {
  it("throws a RETRYABLE transport error when no bytes arrive before the first-byte timeout", async () => {
    const f = scriptedFetch([], true);
    const p = streamChatCompletion(config, req, {
      fetch: f,
      timeouts: { firstByteMs: 40, idleMs: 1000 },
    });
    await expect(p).rejects.toBeInstanceOf(AmbError);
    await expect(p).rejects.toMatchObject({ kind: "transport", retryable: true });
    await expect(p).rejects.toThrow(/no response/i);
  });

  it("throws when the stream goes idle mid-answer (a stalled worker)", async () => {
    const f = scriptedFetch([[0, chunk({ choices: [{ delta: { content: "hel" } }] })]], true);
    const p = streamChatCompletion(config, req, {
      fetch: f,
      timeouts: { firstByteMs: 1000, idleMs: 40 },
    });
    await expect(p).rejects.toMatchObject({ kind: "transport", retryable: true });
    await expect(p).rejects.toThrow(/stalled/i);
  });

  it("keep-alive comments count as liveness; a slow-but-steady stream completes", async () => {
    // Each gap is well under the idle limit, but the whole stream takes longer than it — so it only completes
    // if every chunk (keep-alive comments included) resets the clock. Wide margins keep it steady on slow CI.
    // The real content only arrives at ~600ms, past the 450ms limit — so this passes only if the pings count.
    const f = scriptedFetch([
      [150, enc.encode(": ping\n\n")],
      [150, enc.encode(": ping\n\n")],
      [150, enc.encode(": ping\n\n")],
      [150, chunk({ choices: [{ delta: { content: "ok" } }] })],
      [150, enc.encode("data: [DONE]\n\n")],
    ]);
    const out = await streamChatCompletion(config, req, {
      fetch: f,
      timeouts: { firstByteMs: 450, idleMs: 450 },
    });
    expect(out.content).toBe("ok");
  });

  it("a USER abort is not reported as a stall", async () => {
    const ac = new AbortController();
    const f = scriptedFetch([], true);
    const p = streamChatCompletion(config, req, {
      fetch: f,
      signal: ac.signal,
      timeouts: { firstByteMs: 5000, idleMs: 5000 },
    });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.not.toThrow(/stall|no response/i);
  });
});

describe("Retry-After", () => {
  it("a 429 rate-limit carries the server's Retry-After into the error", async () => {
    const f: FetchLike = async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "12" } });
    await expect(streamChatCompletion(config, req, { fetch: f })).rejects.toMatchObject({
      kind: "rate_limit",
      retryAfterMs: 12_000,
    });
  });
});

describe("a clock firing while an error body is read", () => {
  it("keeps the classified HTTP error (kind + Retry-After), not a generic stall", async () => {
    const f: FetchLike = async (_u, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          init?.signal?.addEventListener("abort", () =>
            ctrl.error(new DOMException("a", "AbortError")),
          );
        }, // never sends the body
      });
      return new Response(body, { status: 429, headers: { "Retry-After": "5" } });
    };
    const p = streamChatCompletion(config, req, {
      fetch: f,
      timeouts: { firstByteMs: 30, idleMs: 30 },
    });
    await expect(p).rejects.toMatchObject({ kind: "rate_limit", retryAfterMs: 5000 });
  });
});
