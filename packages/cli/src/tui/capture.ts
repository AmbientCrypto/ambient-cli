import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { type ImageAttachment, ImageAttachmentSchema } from "@amb/protocol";
import { linuxClipboardImage, resizeImage, windowsClipboardImage } from "./clipboard-image.js";

const run = promisify(execFile);

/** Max on-disk size we'll read into memory as an attachment (rejected at stat, before reading). */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 5_000;

const EXT_MEDIA: Record<string, ImageAttachment["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Clean a burst arriving on stdin (a paste, or a drag-dropped path): drop bracketed-paste markers
 * (`\x1b[200~`/`\x1b[201~`) and any other ANSI CSI escape, normalize CRLF/CR → LF, expand TABs to spaces, and
 * strip stray C0 control characters — keeping the visible text (and newlines). This keeps marker/control
 * garbage out of the composer buffer and lets a dropped path still be recognized once its markers are gone.
 * Tabs become spaces because the terminal expands a raw \t to the next 8-col stop while our width math (and
 * Ink's) measures it as zero — that mismatch desynced the caret/wrap on tab-indented pastes; spaces are width-1
 * so display + caret math stay exact (a prompt doesn't need tab fidelity).
 */
export function normalizePastedText(raw: string): string {
  return (
    raw
      // Bracketed-paste markers, with the ESC OPTIONAL: Ink's key parser often consumes the ESC byte and
      // delivers the bare `[200~` / `[201~` as text, so requiring the ESC would leak the marker into the buffer.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching real terminal control sequences
      .replace(/\x1b?\[20[01]~/g, "")
      // any other ANSI CSI escape (ESC [ params intermediates final)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching real terminal control sequences
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n?/g, "\n") // CRLF / CR -> LF
      .replace(/\t/g, "  ") // expand tabs to spaces so width math == what the terminal shows
      // other C0 controls + DEL (keep \n), incl. any lone ESC left after CSI stripping
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping stray terminal control bytes
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

/** Strip drag-drop decoration (surrounding quotes, backslash-escaped spaces) from a pasted path. */
export function normalizeDroppedPath(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1);
  }
  // `\ ` is a POSIX shell escape; in a Windows path the backslash is the separator, so leave it alone.
  return isWindowsPath(s) ? s.trim() : s.replace(/\\ /g, " ").trim();
}

/** A Windows drive (`C:\…`, `C:/…`) or UNC (`\\server\share`) path. */
export function isWindowsPath(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\");
}

/** A quick, PURE gate: does this look like a single-line FILE PATH to an image? Requires a filesystem-path
 *  prefix (/, ~/, ./, ../) and rejects URL schemes, so pasted prose or an image URL that merely ENDS in
 *  ".png" is NOT diverted to attach (which would otherwise swallow the pasted text). */
export function looksLikeImagePath(raw: string): boolean {
  const s = normalizeDroppedPath(raw);
  if (s.length === 0 || s.includes("\n")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false; // http(s)://…, file://… — a URL, not a local path
  // must be an absolute / home / relative path (drag-drop is absolute), POSIX or Windows
  if (!/^(\/|~\/|\.\.?[\\/])/.test(s) && !isWindowsPath(s)) return false;
  const dot = s.lastIndexOf(".");
  if (dot < 0) return false;
  return Object.keys(EXT_MEDIA).includes(s.slice(dot).toLowerCase());
}

/** Sniff the image media type from magic bytes (authoritative; extension is only a hint). */
export function sniffMediaType(bytes: Uint8Array): ImageAttachment["mediaType"] | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57
  )
    return "image/webp"; // RIFF....WEBP
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  return undefined;
}

/** Pixel dimensions from a PNG/JPEG header (best-effort; undefined for others). */
export function imageDimensions(
  bytes: Uint8Array,
  media: ImageAttachment["mediaType"],
): { width: number; height: number } | undefined {
  if (media === "image/png" && bytes.length >= 24) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) }; // IHDR width/height
  }
  if (media === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1] ?? 0;
      // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15 carry the frame dimensions.
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      const len = ((bytes[i + 2] ?? 0) << 8) + (bytes[i + 3] ?? 0);
      i += 2 + len;
    }
  }
  return undefined;
}

/** Build a validated ImageAttachment from raw image bytes (shared by clipboard + file paths). */
function makeAttachment(
  bytes: Uint8Array,
  media: ImageAttachment["mediaType"],
  source: ImageAttachment["source"],
): ImageAttachment {
  const buf = Buffer.from(bytes);
  const dims = imageDimensions(bytes, media);
  const att: ImageAttachment = {
    id: `att_${randomUUID().slice(0, 8)}`,
    mediaType: media,
    dataBase64: buf.toString("base64"),
    bytes: buf.byteLength,
    sha256: createHash("sha256").update(buf).digest("hex"),
    source,
    ...(dims ? { width: dims.width, height: dims.height } : {}),
  };
  return ImageAttachmentSchema.parse(att);
}

export type CaptureResult =
  | { ok: true; attachment: ImageAttachment }
  | { ok: false; reason: string };

/** Transcode raw bytes to PNG via `sips` (macOS) — used to accept HEIC (the default iPhone photo format) and
 *  any other decodable format. Returns undefined off-darwin, if sips is missing, or on any failure. */
async function transcodeToPng(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (process.platform !== "darwin") return undefined;
  const dir = await mkdtemp(join(tmpdir(), "amb-xcode-"));
  const inPath = join(dir, "in.bin");
  const outPath = join(dir, "out.png");
  try {
    await writeFile(inPath, Buffer.from(bytes));
    await run("sips", ["-s", "format", "png", inPath, "--out", outPath], {
      timeout: CAPTURE_TIMEOUT_MS,
    });
    const st = await stat(outPath).catch(() => undefined);
    if (st?.isFile() && st.size > 0 && st.size <= MAX_ATTACH_BYTES) {
      return new Uint8Array(await readFile(outPath));
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Attach an image FILE the user pasted/dropped/`/attach`ed. Size-checked BEFORE and AFTER read (the stat is
 *  advisory — a growing file / pipe could exceed it), magic-byte verified, HEIC/other formats transcoded. */
export async function attachImageFile(
  rawPath: string,
  source: ImageAttachment["source"] = "file",
): Promise<CaptureResult> {
  return readImageFile(normalizeDroppedPath(rawPath), source);
}

/** Read an image from exactly this path (already checked by the caller — no drag-and-drop clean-up, which
 *  could turn a checked path into a different file). */
export async function readImageFile(
  path: string,
  source: ImageAttachment["source"] = "file",
): Promise<CaptureResult> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return { ok: false, reason: "not a file" };
    if (st.size > MAX_ATTACH_BYTES) return { ok: false, reason: "image too large (>10MB)" };
    const bytes = new Uint8Array(await readFile(path));
    // Re-check AFTER read: stat→read is a TOCTOU window (a growing file, a FIFO/device) — never keep >10MB.
    if (bytes.byteLength > MAX_ATTACH_BYTES)
      return { ok: false, reason: "image too large (>10MB)" };
    const media = sniffMediaType(bytes);
    if (media) return { ok: true, attachment: makeAttachment(bytes, media, source) };
    // Unknown format (e.g. HEIC — the default iPhone/macOS photo) → transcode to PNG before giving up.
    const png = await transcodeToPng(bytes);
    if (png) return { ok: true, attachment: makeAttachment(png, "image/png", source) };
    return { ok: false, reason: "not a supported image (png/jpeg/webp/gif/heic)" };
  } catch {
    return { ok: false, reason: `can't read ${basename(path)}` };
  }
}

/**
 * Read an image from the macOS clipboard (Ctrl+V). First tries raw PNG data («class PNGf», e.g. a screenshot
 * copied with ⌘⇧⌃4); falls back to a copied image FILE («class furl», Finder copy). macOS-only — elsewhere the
 * caller falls back to /attach. Bounded by a 5s timeout; the temp file is always cleaned up.
 */
export async function captureClipboardImage(): Promise<CaptureResult> {
  if (process.platform === "win32") return captureClipboardImageWindows();
  if (process.platform === "linux") {
    const bytes = await linuxClipboardImage();
    if (!bytes) {
      return {
        ok: false,
        reason:
          "no image on the clipboard (image paste needs wl-paste or xclip) — or use /attach <path>",
      };
    }
    if (bytes.byteLength > MAX_ATTACH_BYTES)
      return { ok: false, reason: "image too large (>10MB)" };
    const media = sniffMediaType(bytes);
    if (!media) return { ok: false, reason: "the clipboard holds an unsupported image format" };
    return { ok: true, attachment: makeAttachment(bytes, media, "clipboard") };
  }
  if (process.platform !== "darwin") {
    return { ok: false, reason: "clipboard image paste isn't supported here — use /attach <path>" };
  }
  const dir = await mkdtemp(join(tmpdir(), "amb-clip-"));
  const out = join(dir, "clip.png");
  try {
    // Write the clipboard's PNG data to `out` (or return "no-image"). execFile ARRAY form so the «class PNGf»
    // chevrons reach osascript as UTF-8 argv — never a shell string.
    const script = [
      "on run argv",
      "set outPath to POSIX file (item 1 of argv)",
      "try",
      "set d to the clipboard as «class PNGf»",
      "on error",
      'return "no-image"',
      "end try",
      "try",
      "set fh to open for access outPath with write permission",
      "set eof fh to 0",
      "write d to fh",
      "close access fh",
      'return "ok"',
      "on error",
      "try",
      "close access outPath",
      "end try",
      'return "write-failed"',
      "end try",
      "end run",
    ];
    const args = script.flatMap((line) => ["-e", line]);
    const res = await run("osascript", [...args, out], { timeout: CAPTURE_TIMEOUT_MS });
    if (res.stdout.trim() === "ok") {
      const st = await stat(out).catch(() => undefined);
      if (st?.isFile() && st.size > 0 && st.size <= MAX_ATTACH_BYTES) {
        const bytes = new Uint8Array(await readFile(out));
        const media = sniffMediaType(bytes) ?? "image/png";
        return { ok: true, attachment: makeAttachment(bytes, media, "clipboard") };
      }
    }
    // Fallback: the clipboard holds a copied image FILE — resolve its path and attach that.
    const furl = await run("osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"], {
      timeout: CAPTURE_TIMEOUT_MS,
    }).catch(() => undefined);
    const filePath = furl?.stdout.trim();
    if (filePath) return attachImageFile(filePath, "clipboard");
    return { ok: false, reason: "no image on the clipboard" };
  } catch {
    return { ok: false, reason: "no image on the clipboard" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Windows clipboard: an image (e.g. a Snipping Tool screenshot) or a copied image file. */
async function captureClipboardImageWindows(): Promise<CaptureResult> {
  const dir = await mkdtemp(join(tmpdir(), "amb-clip-"));
  const out = join(dir, "clip.png");
  try {
    const r = await windowsClipboardImage(out);
    if (r === "ok") {
      const bytes = new Uint8Array(await readFile(out));
      if (bytes.byteLength > MAX_ATTACH_BYTES)
        return { ok: false, reason: "image too large (>10MB)" };
      return {
        ok: true,
        attachment: makeAttachment(bytes, sniffMediaType(bytes) ?? "image/png", "clipboard"),
      };
    }
    if (r?.startsWith("file:")) return attachImageFile(r.slice(5), "clipboard");
    return { ok: false, reason: "no image on the clipboard" };
  } catch {
    return { ok: false, reason: "no image on the clipboard" };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/** Downscale an already-captured attachment's longest edge to `maxEdge` (sips on macOS, .NET on Windows,
 *  ImageMagick on Linux), best-effort. Returns the original attachment unchanged if no resizer is available
 *  or the image is already within bounds. */
export async function downscaleForWindow(
  att: ImageAttachment,
  maxEdge: number,
): Promise<ImageAttachment> {
  const longest = Math.max(att.width ?? 0, att.height ?? 0);
  if (longest === 0 || longest <= maxEdge) return att;
  const dir = await mkdtemp(join(tmpdir(), "amb-scale-"));
  const inPath = join(dir, `in.${att.mediaType === "image/png" ? "png" : "jpg"}`);
  const outPath = join(dir, "out.png");
  try {
    await writeFile(inPath, Buffer.from(att.dataBase64, "base64"));
    if (process.platform === "darwin") {
      await run("sips", ["-Z", String(maxEdge), inPath, "--out", outPath], {
        timeout: CAPTURE_TIMEOUT_MS,
      });
    } else if (!(await resizeImage(inPath, outPath, maxEdge))) {
      return att;
    }
    const st = await stat(outPath).catch(() => undefined);
    if (st?.isFile() && st.size > 0) {
      const bytes = new Uint8Array(await readFile(outPath));
      const media = sniffMediaType(bytes) ?? "image/png";
      return makeAttachment(bytes, media, att.source);
    }
    return att;
  } catch {
    return att; // sips missing / failed → keep the original (adaptive limits still bound token cost)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
