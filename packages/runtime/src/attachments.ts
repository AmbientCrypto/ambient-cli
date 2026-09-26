import type { ImageAttachment } from "@amb/protocol";

/** OpenAI content-parts (the runtime's wire-shaping form for a multimodal user message). */
export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ContentPart = TextPart | ImagePart;

/** `data:<mediaType>;base64,<bytes>` — the inline image URL a vision model accepts. */
export function toDataUri(a: Pick<ImageAttachment, "mediaType" | "dataBase64">): string {
  return `data:${a.mediaType};base64,${a.dataBase64}`;
}

/**
 * Build the first user message content. Returns a plain STRING when there are no images OR the served model
 * can't see them (the non-vision path injects a text description separately). Returns content-parts (text +
 * image_url) only on the vision path — the ONLY place image bytes reach the wire.
 */
export function buildUserContent(
  text: string,
  images: readonly ImageAttachment[] | undefined,
  visionCapable: boolean,
): string | ContentPart[] {
  if (!images || images.length === 0 || !visionCapable) return text;
  return [
    { type: "text", text },
    ...images.map((a) => ({ type: "image_url" as const, image_url: { url: toDataUri(a) } })),
  ];
}
