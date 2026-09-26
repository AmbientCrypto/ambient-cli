import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsPowerShellExe } from "@amb/tools-core";

/**
 * Clipboard images and image resizing on Windows and Linux (macOS uses osascript/sips in capture.ts). Every
 * helper is best-effort: a missing tool or an empty clipboard yields `undefined`, never a throw.
 */
const run = promisify(execFile);
const TIMEOUT_MS = 8_000;

/** Quote a value as a PowerShell single-quoted string literal. */
export function psQuote(s: string): string {
  // PowerShell treats the typographic single quotes as quote characters too.
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

/** The PowerShell program that saves the clipboard image to `out` as PNG, or prints a copied file's path. */
export function windowsClipboardScript(out: string): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    `if ($img -ne $null) { $img.Save(${psQuote(out)}, [System.Drawing.Imaging.ImageFormat]::Png); 'ok'; exit }`,
    "$files = [System.Windows.Forms.Clipboard]::GetFileDropList()",
    "if ($files.Count -gt 0) { 'file:' + $files[0]; exit }",
    "'no-image'",
  ].join("; ");
}

/**
 * Windows: save the clipboard image to `out` ("ok"), or return a copied image file's path ("file:<path>").
 * Clipboard access needs a single-threaded apartment, hence -STA.
 */
export async function windowsClipboardImage(out: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      windowsPowerShellExe(),
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", windowsClipboardScript(out)],
      { timeout: TIMEOUT_MS, windowsHide: true },
    );
    const r = stdout.trim();
    return r === "no-image" || r === "" ? undefined : r;
  } catch {
    return undefined;
  }
}

/** Linux: PNG bytes from the clipboard via wl-paste (Wayland) or xclip (X11). */
export async function linuxClipboardImage(): Promise<Uint8Array | undefined> {
  const attempts: Array<[string, string[]]> = [
    ["wl-paste", ["--no-newline", "--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await run(cmd, args, {
        timeout: TIMEOUT_MS,
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
      });
      if (stdout.byteLength > 0) return new Uint8Array(stdout);
    } catch {
      // tool missing or no image — try the next one
    }
  }
  return undefined;
}

/**
 * Resize an image file so its longest edge is `maxEdge`, writing PNG to `outPath`. Windows uses .NET's
 * System.Drawing through PowerShell; Linux uses ImageMagick when installed. Returns false when unavailable.
 */
export async function resizeImage(
  inPath: string,
  outPath: string,
  maxEdge: number,
): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Drawing",
        `$src = [System.Drawing.Image]::FromFile(${psQuote(inPath)})`,
        `$s = [Math]::Min(1.0, ${maxEdge} / [Math]::Max($src.Width, $src.Height))`,
        "$w = [int]($src.Width * $s); $h = [int]($src.Height * $s)",
        "$dst = New-Object System.Drawing.Bitmap $w, $h",
        "$g = [System.Drawing.Graphics]::FromImage($dst)",
        "$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
        "$g.DrawImage($src, 0, 0, $w, $h)",
        `$dst.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
        "$g.Dispose(); $dst.Dispose(); $src.Dispose()",
      ].join("; ");
      await run(windowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeout: TIMEOUT_MS,
        windowsHide: true,
      });
      return true;
    }
    if (process.platform === "linux") {
      for (const cmd of ["magick", "convert"]) {
        try {
          await run(cmd, [inPath, "-resize", `${maxEdge}x${maxEdge}>`, outPath], {
            timeout: TIMEOUT_MS,
          });
          return true;
        } catch {
          // try the next ImageMagick entry point
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}
