import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../src/tools/read.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-readkinds-")));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));
const ctx = (): ToolContext => ({
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
});

describe("read on files that aren't text", () => {
  it("reads a PDF's text page by page, and names a broken one", async () => {
    writeFileSync(join(ws, "spec.pdf"), minimalPdf("Hello from the PDF"));
    const r = await readTool.execute({ path: "spec.pdf" }, ctx());
    expect(r.content).toContain("--- page 1 of 1 ---");
    expect(r.content).toContain("Hello from the PDF");
    writeFileSync(join(ws, "broken.pdf"), "%PDF-1.7 not really");
    await expect(readTool.execute({ path: "broken.pdf" }, ctx())).rejects.toThrow(
      /couldn't read the PDF broken.pdf/,
    );
  });

  it("points an image at view_image, and names binary files instead of returning garbage", async () => {
    writeFileSync(join(ws, "shot.PNG"), "x");
    writeFileSync(join(ws, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    await expect(readTool.execute({ path: "shot.PNG" }, ctx())).rejects.toThrow(/view_image/);
    await expect(readTool.execute({ path: "blob.bin" }, ctx())).rejects.toThrow(
      /binary file \(4 bytes\)/,
    );
  });

  it("still reads text", async () => {
    writeFileSync(join(ws, "a.txt"), "one\r\ntwo");
    expect((await readTool.execute({ path: "a.txt" }, ctx())).content).toBe("1\tone\n2\ttwo");
  });
});

/** A one-page PDF showing `text` (offsets computed, so it's a well-formed file). */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
