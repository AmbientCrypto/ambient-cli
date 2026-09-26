import { describe, expect, it } from "vitest";
import {
  imageDimensions,
  looksLikeImagePath,
  normalizeDroppedPath,
  normalizePastedText,
  sniffMediaType,
} from "../src/tui/capture.js";

describe("normalizePastedText (bracketed-paste + control-byte hygiene)", () => {
  it("strips bracketed-paste markers, keeping the content and its newlines", () => {
    const raw = "\x1b[200~first line\nsecond line\x1b[201~";
    expect(normalizePastedText(raw)).toBe("first line\nsecond line");
  });
  it("strips a BARE [200~/[201~ marker too (Ink consumes the ESC, leaving the marker as text)", () => {
    expect(normalizePastedText("[200~first line\nsecond[201~")).toBe("first line\nsecond");
  });
  it("normalizes CRLF and lone CR to LF", () => {
    expect(normalizePastedText("a\r\nb\rc")).toBe("a\nb\nc");
  });
  it("drops stray control bytes and any lone ESC, keeps \\n, and expands \\t to spaces", () => {
    expect(normalizePastedText("a\x07b\tc\nd")).toBe("ab  c\nd"); // tab → 2 spaces (exact width math)
    expect(normalizePastedText("x\x1by")).toBe("xy"); // lone ESC removed
  });

  it("expands tabs in a code paste so width/caret math matches the terminal", () => {
    expect(normalizePastedText("\t\tif (x) {\n\t\t\treturn;")).toBe("    if (x) {\n      return;");
  });
  it("a drag-dropped path wrapped in paste markers survives as a clean path (still attach-detectable)", () => {
    const cleaned = normalizePastedText("\x1b[200~/Users/alice/pic.png\x1b[201~");
    expect(cleaned).toBe("/Users/alice/pic.png");
    expect(looksLikeImagePath(cleaned)).toBe(true);
  });
});

// A minimal PNG header: 8-byte signature + IHDR chunk with width=800, height=600.
const png = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // signature
  0x00,
  0x00,
  0x00,
  0x0d, // IHDR length (13)
  0x49,
  0x48,
  0x44,
  0x52, // "IHDR"
  0x00,
  0x00,
  0x03,
  0x20, // width = 800
  0x00,
  0x00,
  0x02,
  0x58, // height = 600
]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

describe("capture pure helpers", () => {
  it("normalizeDroppedPath strips quotes + backslash-escaped spaces", () => {
    expect(normalizeDroppedPath("'/Users/alice/My Shots/a.png'")).toBe(
      "/Users/alice/My Shots/a.png",
    );
    expect(normalizeDroppedPath("/Users/alice/My\\ Shots/a.png")).toBe(
      "/Users/alice/My Shots/a.png",
    );
  });

  it("looksLikeImagePath accepts a real image PATH, rejects prose / URLs / multi-line / non-image", () => {
    expect(looksLikeImagePath("/Users/alice/shot.png")).toBe(true);
    expect(looksLikeImagePath("'/Users/alice/My Shots/a.jpeg'")).toBe(true);
    expect(looksLikeImagePath("./relative/pic.webp")).toBe(true);
    expect(looksLikeImagePath("just some typed words")).toBe(false);
    expect(looksLikeImagePath("/Users/alice/a.png\nsecond line")).toBe(false);
    expect(looksLikeImagePath("/Users/alice/notes.txt")).toBe(false);
    // Regression: prose or an image URL ending in ".png" must NOT be diverted to attach (text-loss).
    expect(looksLikeImagePath("here is the file photo.png")).toBe(false); // no path prefix → not a path
    expect(looksLikeImagePath("https://example.com/photo.png")).toBe(false); // URL, not a local path
    expect(looksLikeImagePath("check out cover.jpg for details")).toBe(false);
  });

  it("sniffMediaType reads magic bytes (authoritative, not the extension)", () => {
    expect(sniffMediaType(png)).toBe("image/png");
    expect(sniffMediaType(jpeg)).toBe("image/jpeg");
    expect(sniffMediaType(gif)).toBe("image/gif");
    expect(sniffMediaType(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });

  it("imageDimensions reads a PNG IHDR", () => {
    expect(imageDimensions(png, "image/png")).toEqual({ width: 800, height: 600 });
  });
});
