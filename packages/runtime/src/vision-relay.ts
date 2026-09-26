import { createHash } from "node:crypto";
import { guardUntrustedResult } from "@amb/permissions";
import { AmbError, type CatalogModel, supportsVision } from "@amb/protocol";
import { UNKNOWN_OUTPUT, UNKNOWN_WINDOW, rankVisionModels, streamTimeouts } from "@amb/reliability";
import type { ChatClient } from "./ports.js";

/**
 * The NON-VISION RELAY: when the served model can't see images, a ready VISION-capable model from the SAME
 * Ambient catalog describes the attached image(s) in a target-optimised, text form, which is then injected
 * into the served model's user message. This gives any model without image input a usable vision workaround —
 * Ambient-only, never an external API. Bounded (per-request timeouts, failover across vision peers); honest on
 * failure (no fabricated description — a degrade note tells the model it couldn't see the image).
 */

export const RELAY_TIMEOUT_MS = 90_000;

const DESCRIBE_PROMPT =
  "Describe the attached image(s) in precise, structured detail for another AI that CANNOT see them. " +
  "Transcribe ALL visible text verbatim (UI labels, code, terminal output, error messages, numbers), " +
  "describe layout/structure, and call out anything that looks task-relevant. Be thorough and literal; " +
  "do not speculate beyond what is visible.";

export type RelayOutcome = "described" | "no-model" | "cold" | "failed";

export interface RelayResult {
  outcome: RelayOutcome;
  /** The vision model that produced (or would have produced) the description. */
  visionModel?: string;
  /** The description text — present only when outcome === "described". */
  description?: string;
  /** Every vision model attempted, in order (for an honest "tried X, Y" message). */
  tried?: string[];
}

export interface RelayDeps {
  client: ChatClient;
  catalog: CatalogModel[];
  /** The attached images as data URIs (data:image/...;base64,...) — the caller encodes them. */
  imageDataUris: readonly string[];
  /** The user's text (so the description is written with the task in mind). */
  userText: string;
  signal: AbortSignal;
  /** Window of the model that will READ the description (bounds how long it may be). */
  targetWindow?: number;
  /** Called as each vision model is tried, BEFORE its request — lets the UI show the relay working. */
  onAttempt?: (visionModel: string, imageCount: number) => void;
  /** Descriptions by image; defaults to a process-wide cache so an image is described once per session. */
  cache?: Map<string, string>;
  /** Replaces the general "describe everything" instruction (e.g. a specific question about the image). */
  instruction?: string;
}

/** Build the one-shot vision request content (describe prompt + the image parts). */
export function toVisionContent(
  userText: string,
  imageDataUris: readonly string[],
  instruction?: string,
): unknown[] {
  const ask = instruction
    ? instruction
    : userText.trim()
      ? `${DESCRIBE_PROMPT}\n\nThe user's request (describe with this in mind): ${userText.trim().slice(0, 600)}`
      : DESCRIBE_PROMPT;
  return [
    { type: "text", text: ask },
    ...imageDataUris.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

/** Most vision peers one relay will try before giving up. */
const MAX_RELAY_ATTEMPTS = 4;
/** Worst-case tokens for one full-detail image (the planner's square-at-max-edge bound). */
const PER_IMAGE_TOKENS = 4_300;
const CACHE_LIMIT = 64;
const sharedCache = new Map<string, string>();

/** Forget every cached description (tests, or a fresh session). */
export function clearRelayCache(): void {
  sharedCache.clear();
}

/** A description is written for one request, so it's reused only for the same image AND the same ask. */
const imageKey = (uri: string, ask: string) =>
  createHash("sha256").update(uri).update("\0").update(ask).digest("hex");

/** Images per request so they fit the vision model's window (at least one). */
function batchSize(window: number): number {
  return Math.max(1, Math.floor((window * 0.45) / PER_IMAGE_TOKENS));
}

/**
 * Describe the image(s) via a vision model from the live catalog, trying peers in order (ready first). The
 * catalog's readiness flag is only a hint — a flagged model is still tried, and only a real "no workers"
 * answer from every peer makes the outcome `cold`. Many images are split into requests that fit the vision
 * model's window; an image already described this session is reused from the cache. Each request is bounded.
 */
export async function relayImageToText(deps: RelayDeps): Promise<RelayResult> {
  const { client, catalog, imageDataUris, userText, signal } = deps;
  const cache = deps.cache ?? sharedCache;
  const ask = deps.instruction ?? userText.trim().slice(0, 600);
  const keys = imageDataUris.map((uri) => imageKey(uri, ask));
  const labelled = (texts: string[]) =>
    texts.length === 1
      ? (texts[0] as string)
      : texts.map((t, i) => `Image #${i + 1}: ${t}`).join("\n\n");

  // Everything already described this session → no call at all.
  const cached = keys.map((k) => cache.get(k));
  if (cached.every((c): c is string => typeof c === "string")) {
    return { outcome: "described", description: labelled(cached), tried: [] };
  }

  const candidates = rankVisionModels(catalog).slice(0, MAX_RELAY_ATTEMPTS);
  if (candidates.length === 0) return { outcome: "no-model" };
  const tried: string[] = [];
  let allCold = true;
  for (const id of candidates) {
    if (signal.aborted) return { outcome: "failed", tried };
    tried.push(id);
    deps.onAttempt?.(id, imageDataUris.length);
    const model = catalog.find((m) => m.id === id);
    const window = model?.contextLength ?? UNKNOWN_WINDOW;
    const size = batchSize(window);
    const batches = Math.ceil(imageDataUris.length / size);
    // Room for a thorough description: the vision model's own output cap, with ALL batches together bounded
    // by a tenth of what the READER can hold.
    const descTokens = Math.max(
      Math.min(512, Math.floor(((deps.targetWindow ?? UNKNOWN_WINDOW) * 0.1) / batches)),
      Math.min(
        model?.maxOutputLength ?? UNKNOWN_OUTPUT,
        Math.floor(((deps.targetWindow ?? UNKNOWN_WINDOW) * 0.1) / batches),
      ),
    );
    try {
      const out: string[] = [];
      for (let start = 0; start < imageDataUris.length; start += size) {
        const idx = [...imageDataUris.keys()].slice(start, start + size);
        const hit = idx.map((i) => cache.get(keys[i] as string));
        if (hit.every((h): h is string => typeof h === "string")) {
          out.push(
            ...hit.map((h, j) =>
              imageDataUris.length === 1 ? h : `Image #${start + j + 1}: ${h}`,
            ),
          );
          continue;
        }
        const batch = idx.map((i) => imageDataUris[i] as string);
        const text = await describeOnce(
          client,
          id,
          model,
          batch,
          userText,
          descTokens,
          signal,
          deps.instruction,
        );
        if (!text) throw new Error("empty description");
        const label =
          imageDataUris.length === 1
            ? text
            : `Images #${start + 1}${idx.length > 1 ? `–#${start + idx.length}` : ""}: ${text}`;
        out.push(label);
        if (batch.length === 1) remember(cache, keys[start] as string, text);
      }
      return { outcome: "described", visionModel: id, description: out.join("\n\n"), tried };
    } catch (e) {
      if (signal.aborted) return { outcome: "failed", visionModel: id, tried }; // the run was cancelled
      if (!(e instanceof AmbError && e.kind === "cold")) allCold = false;
    }
  }
  return { outcome: allCold ? "cold" : "failed", tried };
}

/** One bounded describe request for a batch of images. Throws on failure; empty text means "no answer". */
async function describeOnce(
  client: ChatClient,
  id: string,
  model: CatalogModel | undefined,
  batch: string[],
  userText: string,
  maxTokens: number,
  signal: AbortSignal,
  instruction?: string,
): Promise<string> {
  // Link the run's signal to a per-request timeout so a hung vision call can't stall the run forever.
  const linked = new AbortController();
  const onAbort = () => linked.abort();
  if (signal.aborted) linked.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => linked.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await client.chat({
      model: id,
      messages: [{ role: "user", content: toVisionContent(userText, batch, instruction) }],
      tools: [],
      maxTokens,
      // Mechanical transcription — no reasoning spend.
      ...(model?.supportedFeatures.includes("reasoning")
        ? { reasoningEffort: "none" as const }
        : {}),
      // Images are a large, slow prefill; the watchdog still catches a silent worker well before the cap.
      timeouts: streamTimeouts({
        promptTokens: PER_IMAGE_TOKENS * batch.length,
        flaggedCold: model?.isReady === false,
      }),
      signal: linked.signal,
      hasImage: true,
    });
    return (res.content ?? "").trim();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function remember(cache: Map<string, string>, key: string, text: string): void {
  cache.set(key, text);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Fold the relay outcome into the served model's user text. On success the description is labelled and clearly
 * attributed to the vision model; on failure an HONEST note tells the model it couldn't see the image — never a
 * fabricated description. Folded into the USER message (not the system anchor), so it can't displace the goal.
 */
export function injectDescription(userText: string, result: RelayResult): string {
  const base = userText.trim();
  if (result.outcome === "described" && result.description) {
    // Text inside an image (a screenshot of a web page) reaches the description, so it's guarded like
    // any untrusted output.
    const description = guardUntrustedResult(result.description).text;
    return `${base}\n\n[The model serving you cannot see images. ${result.visionModel ?? "A vision model"} looked at the attached image(s) and described them below. For anything the description doesn't cover, ask a follow-up with the ask_vision tool.]\n${description}`;
  }
  const why =
    result.outcome === "no-model"
      ? "no vision-capable model is available right now"
      : result.outcome === "cold"
        ? "every vision-capable model is cold right now"
        : "the image could not be described";
  return `${base}\n\n[You were sent an image, but the model serving you can't see images and ${why}. Work from the text; if the image is essential, ask the user to describe it.]`;
}

/** Re-export the predicate so callers decide the vision-vs-relay branch from one place. */
export { supportsVision };
