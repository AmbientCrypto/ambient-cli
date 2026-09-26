import { describe, expect, it } from "vitest";
import { decodeEntities, extractTitle, htmlToText } from "../src/net/html-to-text.js";

describe("decodeEntities", () => {
  it("decodes named + numeric + hex, leaves unknown intact", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;")).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("&nbsp;x")).toBe(" x");
    expect(decodeEntities("&unknownentity;")).toBe("&unknownentity;");
    expect(decodeEntities("&#9999999999;")).toBe("&#9999999999;"); // out of range → untouched
  });
});

describe("extractTitle", () => {
  it("pulls the decoded title or undefined", () => {
    expect(extractTitle("<html><head><title>Hello &amp; Bye</title></head>")).toBe("Hello & Bye");
    expect(extractTitle("<title>  spaced  \n title </title>")).toBe("spaced title");
    expect(extractTitle("<html><body>no title</body></html>")).toBeUndefined();
  });
});

describe("htmlToText", () => {
  it("strips script/style/head noise and never leaks their contents", () => {
    const html = `<html><head><style>.x{color:red}</style><title>T</title></head>
      <body><script>alert('xss')</script><p>Visible one</p><p>Visible two</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Visible one");
    expect(text).toContain("Visible two");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });
  it("turns block boundaries and <br> into newlines", () => {
    expect(htmlToText("<p>a</p><p>b</p>")).toBe("a\nb");
    expect(htmlToText("line1<br>line2")).toBe("line1\nline2");
    expect(htmlToText("<li>one</li><li>two</li>")).toBe("one\ntwo");
  });
  it("decodes entities in body text and collapses whitespace", () => {
    expect(htmlToText("<p>a &amp;   b</p>")).toBe("a & b");
    expect(htmlToText("<div>x</div>\n\n\n\n<div>y</div>")).toBe("x\n\ny");
  });
  it("handles a hostile-shaped input in linear time (no catastrophic backtracking)", () => {
    const hostile = `${"<".repeat(20000)}a${">".repeat(20000)}`;
    const start = process.hrtime.bigint();
    htmlToText(hostile);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(1000);
  });
  it("is LINEAR on a large run of unbalanced '<' (quadratic-DoS regression)", () => {
    // The old greedy regex was O(n²): 32k '<' took ~400ms. A linear scan handles 500k in a few ms.
    const ms = (n: number) => {
      const s = "<".repeat(n);
      const t = process.hrtime.bigint();
      htmlToText(s);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    expect(ms(500_000)).toBeLessThan(250); // would be many seconds if quadratic
    // Many noise blocks must ALSO stay linear (the close-tag scan reuses one lowercased copy).
    const manyBlocks = "<script></script>".repeat(50_000);
    const t = process.hrtime.bigint();
    htmlToText(manyBlocks);
    expect(Number(process.hrtime.bigint() - t) / 1e6).toBeLessThan(250);
  });
  it("drops the content of an UNCLOSED script/style block (never leaks it)", () => {
    expect(htmlToText("<p>before</p><script>SECRET_TOKEN")).toBe("before");
    expect(htmlToText("<style>.a{}")).toBe("");
    // a close tag with a longer name must NOT end the block early
    expect(htmlToText("<script>x</scripting>still-secret</script>after")).toBe("after");
  });
});
