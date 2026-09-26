import { describe, expect, it } from "vitest";
import { PREVIEW_MAX_CHARS, toolPreviewBody } from "../src/presentation/tool-preview.js";

describe("toolPreviewBody (one shared approval preview)", () => {
  it("renders a write as add lines", () => {
    const { lines } = toolPreviewBody({ content: "a\nb" }, 40);
    expect(lines).toEqual([
      { kind: "add", text: "+ a" },
      { kind: "add", text: "+ b" },
    ]);
  });

  it("renders an edit as del then add", () => {
    const { lines } = toolPreviewBody({ oldString: "x", newString: "y" }, 40);
    expect(lines).toEqual([
      { kind: "del", text: "- x" },
      { kind: "add", text: "+ y" },
    ]);
  });

  it("honors a pre-supplied unified diff (now supported by BOTH surfaces)", () => {
    const { lines } = toolPreviewBody({ diff: "--- a\n+++ b\n-old\n+new\n ctx" }, 40);
    expect(lines.map((l) => l.kind)).toEqual(["ctx", "ctx", "del", "add", "ctx"]);
  });

  it("windows to maxLines with an honest hidden count", () => {
    const { lines, hidden } = toolPreviewBody({ content: "1\n2\n3\n4\n5" }, 2);
    expect(lines.length).toBe(2);
    expect(hidden).toBe(3);
  });

  it("char-truncates a huge value and flags it (shared cap)", () => {
    const { charTruncated } = toolPreviewBody({ content: "x".repeat(PREVIEW_MAX_CHARS + 10) }, 40);
    expect(charTruncated).toBe(true);
  });
});
