import { describe, expect, it } from "vitest";
import {
  AttachmentRefSchema,
  ImageAttachmentSchema,
  supportsVision,
  toAttachmentRef,
} from "../src/index.js";

describe("supportsVision", () => {
  it("is true iff inputModalities includes 'image' (case-insensitive), never hardcoded", () => {
    expect(supportsVision({ inputModalities: ["text", "image"] })).toBe(true);
    expect(supportsVision({ inputModalities: ["text", "IMAGE"] })).toBe(true);
    expect(supportsVision({ inputModalities: ["text"] })).toBe(false);
    expect(supportsVision({ inputModalities: [] })).toBe(false);
  });
});

describe("ImageAttachment schema", () => {
  const valid = {
    id: "att_1",
    mediaType: "image/png" as const,
    dataBase64: "AAAA",
    bytes: 3,
    sha256: "abc",
    source: "clipboard" as const,
  };
  it("accepts a valid attachment", () => {
    expect(ImageAttachmentSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects a bad media type and negative bytes", () => {
    expect(ImageAttachmentSchema.safeParse({ ...valid, mediaType: "image/tiff" }).success).toBe(
      false,
    );
    expect(ImageAttachmentSchema.safeParse({ ...valid, bytes: -1 }).success).toBe(false);
  });
  it("toAttachmentRef strips the bytes (never logged) but keeps the reference fields", () => {
    const ref = toAttachmentRef(valid);
    expect(ref).not.toHaveProperty("dataBase64");
    expect(ref.sha256).toBe("abc");
    expect(AttachmentRefSchema.safeParse(ref).success).toBe(true);
  });
});
