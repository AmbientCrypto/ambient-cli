import { describe, expect, it } from "vitest";
import { isWindowsPath, looksLikeImagePath, normalizeDroppedPath } from "../src/tui/capture.js";
import { psQuote, windowsClipboardScript } from "../src/tui/clipboard-image.js";

const r = String.raw;

describe("Windows image paths", () => {
  it("recognizes drive-letter and UNC image paths dropped into the terminal", () => {
    expect(looksLikeImagePath(r`C:\Users\me\shot.png`)).toBe(true);
    expect(looksLikeImagePath(r`"C:\Users\me\my shot.png"`)).toBe(true);
    expect(looksLikeImagePath(r`\\server\share\a.jpg`)).toBe(true);
    expect(looksLikeImagePath(r`C:\notes.txt`)).toBe(false);
  });
  it("keeps backslashes in Windows paths (separators, not escapes); unescapes POSIX drops", () => {
    expect(isWindowsPath(r`C:\a b\x.png`)).toBe(true);
    expect(normalizeDroppedPath(r`C:\a b\x.png`)).toBe(r`C:\a b\x.png`);
    expect(normalizeDroppedPath(r`/Users/me/my\ shot.png`)).toBe("/Users/me/my shot.png");
  });
});

describe("PowerShell clipboard script", () => {
  it("quotes the output path safely (single quotes doubled)", () => {
    expect(psQuote(r`C:\Temp\it's.png`)).toBe(r`'C:\Temp\it''s.png'`);
    expect(windowsClipboardScript(r`C:\t\c.png`)).toContain("GetFileDropList");
  });
});
