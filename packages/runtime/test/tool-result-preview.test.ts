import { describe, expect, it } from "vitest";
import { PREVIEW_MAX_CHARS, previewResult } from "../src/tool-result-preview.js";

/** The core regression guard: a preview must NEVER be a raw JSON envelope of the result. */
function assertNotJsonEnvelope(s: string | undefined) {
  expect(s).toBeDefined();
  const t = s ?? "";
  expect(t.startsWith("{")).toBe(false);
  expect(t.startsWith("[")).toBe(false);
  // no escaped tab/newline sequences leaking through as literal text
  expect(t.includes("\\t")).toBe(false);
  expect(t.includes("\\n")).toBe(false);
  // no quoted structural keys from the envelope
  expect(t.includes('"content"')).toBe(false);
  expect(t.includes('"stdout"')).toBe(false);
  expect(t.includes('"matches"')).toBe(false);
}

describe("previewResult — human-readable tool previews (no JSON envelope)", () => {
  it('read → shows the file contents, not {"path":…}', () => {
    const out = previewResult("read", {
      path: "/w/a.ts",
      lines: 2,
      content: "1\texport const x = 1;\n2\texport const y = 2;",
      truncated: false,
    });
    assertNotJsonEnvelope(out);
    expect(out).toContain("export const x = 1;");
    expect(out).toContain("export const y = 2;");
    // real newline preserved (multi-line), not an escaped \n
    expect(out).toContain("\n");
  });

  it('bash → shows stdout, labels stderr, notes non-zero exit — not {"command":…}', () => {
    const out = previewResult("bash", {
      command: "wc -l a.log",
      exitCode: 0,
      stdout: "   1270 a.log\n",
      stderr: "",
      truncated: false,
    });
    assertNotJsonEnvelope(out);
    expect(out).toContain("1270 a.log");
    expect(out).not.toContain('"exitCode"');
  });

  it("bash → non-zero exit and stderr are surfaced", () => {
    const out = previewResult("bash", {
      command: "false",
      exitCode: 2,
      stdout: "",
      stderr: "boom",
      truncated: false,
    });
    expect(out).toContain("boom");
    expect(out).toContain("exit 2");
  });

  it("grep → renders file:line: text lines", () => {
    const out = previewResult("grep", {
      pattern: "TODO",
      matches: [
        { file: "src/a.ts", line: 12, text: "  // TODO fix" },
        { file: "src/b.ts", line: 3, text: "// TODO later" },
      ],
      truncated: false,
    });
    assertNotJsonEnvelope(out);
    expect(out).toContain("src/a.ts:12: // TODO fix");
    expect(out).toContain("src/b.ts:3: // TODO later");
  });

  it("list / glob / web_search render names & links, not envelopes", () => {
    expect(
      previewResult("list", {
        path: ".",
        entries: [
          { name: "src", dir: true },
          { name: "x.ts", dir: false },
        ],
      }),
    ).toContain("src/");
    expect(
      previewResult("glob", { pattern: "*.ts", matches: ["a.ts", "b.ts"], truncated: false }),
    ).toContain("a.ts");
    // Soft results read calm, not as a crash: a timed-out glob says "partial"; a missing dir says "not found".
    expect(
      previewResult("glob", { pattern: "**", matches: ["a.ts"], truncated: true, timedOut: true }),
    ).toContain("partial");
    expect(previewResult("list", { path: "x", entries: [], notFound: true })).toContain(
      "not found",
    );
    const ws = previewResult("web_search", {
      query: "q",
      provider: "p",
      results: [{ title: "T", url: "https://x", snippet: "s" }],
    });
    expect(ws).toContain("T — https://x");
  });

  it("empty results give a friendly note, not '{}'", () => {
    expect(previewResult("grep", { pattern: "z", matches: [], truncated: false })).toBe(
      "no matches",
    );
    expect(previewResult("read", { path: "e", lines: 0, content: "", truncated: false })).toBe(
      "(empty file)",
    );
  });

  it("errors are shown as the error text", () => {
    expect(previewResult("bash", undefined, "denied: plan mode is read-only")).toBe(
      "denied: plan mode is read-only",
    );
  });

  it("caps a huge output by lines with an honest marker, within the char ceiling", () => {
    const content = Array.from({ length: 100 }, (_, i) => `${i + 1}\tline ${i + 1}`).join("\n");
    const out = previewResult("read", { path: "big", lines: 100, content, truncated: false }) ?? "";
    expect(out).toContain("more line");
    expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 40);
  });

  it("unknown tool never dumps a JSON envelope", () => {
    const out = previewResult("mysterytool", { weird: { nested: [1, 2, 3] }, count: 4, ok: true });
    assertNotJsonEnvelope(out);
    expect(out).toContain("count: 4");
  });

  // --- regression tests ---

  it("bash → a FAILURE signal survives a long stdout (exit + stderr are not buried by the line cap)", () => {
    const stdout = Array.from({ length: 20 }, (_, i) => `line ${i + 1} of output`).join("\n");
    const out =
      previewResult("bash", {
        command: "make",
        exitCode: 1,
        stdout,
        stderr: "fatal: something broke",
        truncated: false,
      }) ?? "";
    expect(out).toContain("exit 1"); // the failure is visible…
    expect(out).toContain("fatal: something broke"); // …and so is why
  });

  it("web_search → a result missing a title/url never emits a stray ' — ' line", () => {
    const out =
      previewResult("web_search", {
        query: "q",
        provider: "p",
        results: [{ url: "https://example.com" }, { snippet: "orphan" }],
      }) ?? "";
    expect(out).not.toMatch(/^\s*—/m); // no leading dash-only line
    expect(out).toContain("https://example.com");
  });

  it("list → a big directory shows an honest '+N more lines' marker, never a mid-filename cut", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      name: `very-long-file-name-number-${i}.ts`,
      dir: false,
    }));
    const out = previewResult("list", { path: ".", entries }) ?? "";
    expect(out).toContain("more line"); // the omitted count is surfaced
    expect(out).toContain("very-long-file-name-number-0.ts"); // a whole name, not cut mid-word
  });
});
