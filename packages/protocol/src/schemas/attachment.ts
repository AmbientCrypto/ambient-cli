import { z } from "zod";

/** Image media types we send to vision models. Other decodable formats (e.g. HEIC — the default iPhone photo)
 *  are transcoded to png at the CLI edge before an attachment is built; truly-unknown bytes are rejected. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/**
 * One image the user attached (Ctrl+V / drag-drop / /attach). Immutable, validated at the CLI boundary before
 * it enters a run. `dataBase64` is the RAW base64 (no `data:` prefix); the bytes go to the session object store
 * keyed by `sha256`, so the durable event log only ever carries the reference (AttachmentRef), never the bytes.
 */
export const ImageAttachmentSchema = z.object({
  id: z.string().min(1),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  dataBase64: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  source: z.enum(["clipboard", "file", "drag"]),
  /** Pixel dimensions when known (for adaptive tiling); absent ⇒ estimate from a default tile count. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;

/** The reference persisted in the JSONL event log — everything EXCEPT the base64 bytes (which would bloat it). */
export const AttachmentRefSchema = ImageAttachmentSchema.omit({ dataBase64: true });
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/** Strip the bytes from an attachment for durable logging. */
export function toAttachmentRef(a: ImageAttachment): AttachmentRef {
  const { dataBase64: _bytes, ...ref } = a;
  return ref;
}
