import { HIGH_DETAIL_IMAGE_WINDOW } from "@amb/reliability";

/**
 * ADAPTIVE image planning — pure, no I/O. Decides, from the SERVED model's context window, how detailed an
 * image may be (downscale edge + token cost) and how many images fit alongside the prompt, so a pasted
 * screenshot can never blow the window. Nothing here is hardcoded to a model; everything scales off the
 * live `contextLength`. (OpenAI-style 512px tiling is the cost model — deliberately conservative / rounds up.)
 */

export const IMAGE_TILE_PX = 512;
// Calibrated against MEASURED Ambient usage: a real 1400x900 (6-tile) image cost ~1655 prompt tokens, so the
// per-tile + base are set CONSERVATIVELY (higher than the OpenAI 170/85 reference) to cover it + headroom —
// under-counting risks a real overflow, over-counting only reserves a little extra room.
export const IMAGE_TILE_TOKENS = 260;
export const IMAGE_BASE_TOKENS = 130;
export const IMAGE_LOW_TOKENS = 130; // "low detail" is a single flat-cost thumbnail
/** Images may claim at most this fraction of the window (the rest is prompt + tools + output). */
export const IMAGE_BUDGET_FRACTION = 0.45;
export const IMAGE_EDGE_LOW = 768;
export const IMAGE_EDGE_MED = 1024;
export const IMAGE_EDGE_HIGH = 1568;
export const WINDOW_LOW_DETAIL = 40_000; // below this → low detail, 1 image
export const WINDOW_HIGH_DETAIL = HIGH_DETAIL_IMAGE_WINDOW; // at/above this → full detail, up to HARD_MAX_IMAGES
export const HARD_MAX_IMAGES = 6;

export interface ImagePlan {
  detail: "low" | "high";
  /** Downscale the longest edge to this many px BEFORE encoding (bounds bytes + tiles). */
  maxEdge: number;
  /** Adaptive cap on how many images may ride with one message. */
  maxImages: number;
  /** Conservative worst-case token cost of ONE image at this plan (a square at maxEdge). */
  perImageTokens: number;
}

/** Tiles for a (possibly non-square) image whose longest edge is downscaled to `maxEdge`. */
export function estimateImageTokens(
  width: number,
  height: number,
  detail: "low" | "high",
  maxEdge: number,
): number {
  if (detail === "low") return IMAGE_LOW_TOKENS;
  const longest = Math.max(width, height, 1);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const tiles = Math.ceil(w / IMAGE_TILE_PX) * Math.ceil(h / IMAGE_TILE_PX);
  return IMAGE_BASE_TOKENS + tiles * IMAGE_TILE_TOKENS;
}

/** Worst-case (square-at-maxEdge) per-image token cost for a detail level — the planning upper bound. */
function squareTokens(detail: "low" | "high", maxEdge: number): number {
  return estimateImageTokens(maxEdge, maxEdge, detail, maxEdge);
}

/** Decide the image plan from the served model's context window (nothing hardcoded to a model). */
export function planImages(contextWindow: number): ImagePlan {
  if (contextWindow < WINDOW_LOW_DETAIL) {
    return {
      detail: "low",
      maxEdge: IMAGE_EDGE_LOW,
      maxImages: 1,
      perImageTokens: IMAGE_LOW_TOKENS,
    };
  }
  if (contextWindow >= WINDOW_HIGH_DETAIL) {
    return {
      detail: "high",
      maxEdge: IMAGE_EDGE_HIGH,
      maxImages: HARD_MAX_IMAGES,
      perImageTokens: squareTokens("high", IMAGE_EDGE_HIGH),
    };
  }
  return {
    detail: "high",
    maxEdge: IMAGE_EDGE_MED,
    maxImages: 3,
    perImageTokens: squareTokens("high", IMAGE_EDGE_MED),
  };
}

export interface FitResult<T> {
  /** The images that fit (newest kept) — EMPTY signals "can't fit any → relay/skip". */
  kept: T[];
  dropped: number;
  detail: "low" | "high";
  perImageTokens: number;
}

/**
 * Fit `images` into the window alongside `promptTokens`: reserve the rest for prompt/tools/output, then keep
 * the newest images that fit at the plan's detail. If not even one fits at high detail, degrade to low ONCE.
 * Generic over the image type — this module stays pure and dependency-light.
 */
export function fitImages<T>(
  images: readonly T[],
  contextWindow: number,
  promptTokens: number,
  plan: ImagePlan,
): FitResult<T> {
  const imageBudget = Math.max(0, Math.floor(contextWindow * IMAGE_BUDGET_FRACTION) - promptTokens);
  const capAt = (per: number): number =>
    Math.max(
      0,
      Math.min(plan.maxImages, HARD_MAX_IMAGES, Math.floor(imageBudget / Math.max(1, per))),
    );

  let detail = plan.detail;
  let per = plan.perImageTokens;
  let cap = capAt(per);
  if (cap === 0 && detail === "high") {
    detail = "low";
    per = IMAGE_LOW_TOKENS;
    cap = capAt(per);
  }
  const kept = cap >= images.length ? [...images] : images.slice(images.length - cap); // keep the NEWEST
  return { kept, dropped: images.length - kept.length, detail, perImageTokens: per };
}
