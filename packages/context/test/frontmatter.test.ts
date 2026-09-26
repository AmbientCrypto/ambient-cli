import { describe, expect, it } from "vitest";
import { boolField, listField, parseFrontmatter, textField } from "../src/frontmatter.js";

describe("frontmatter", () => {
  it("reads real YAML: lists, block scalars, quotes", () => {
    const fm = parseFrontmatter(
      '---\nname: reviewer\ntools: ["Read", "Grep"]\ndescription: >-\n  Reviews code\n  for bugs.\nmodel: \'sonnet\'\n---\nBody text\n',
    );
    expect(fm?.body).toBe("Body text");
    expect(textField(fm?.data ?? {}, "name")).toBe("reviewer");
    expect(listField(fm?.data ?? {}, "tools")).toEqual(["Read", "Grep"]);
    expect(textField(fm?.data ?? {}, "description")).toBe("Reviews code for bugs.");
    expect(textField(fm?.data ?? {}, "model")).toBe("sonnet");
  });
  it("falls back to loose lines when the YAML is invalid (unquoted colon)", () => {
    const fm = parseFrontmatter("---\nname: x\ndescription: Use when: the user asks\n---\nb");
    expect(textField(fm?.data ?? {}, "description")).toBe("Use when: the user asks");
  });
  it("accepts comma- or space-separated tool strings, CRLF files and a BOM", () => {
    const fm = parseFrontmatter("﻿---\r\ntools: Read, Write Bash\r\n---\r\nbody\r\n");
    expect(listField(fm?.data ?? {}, "tools")).toEqual(["Read", "Write", "Bash"]);
    expect(fm?.body).toBe("body");
  });
  it("reads booleans in either form and returns null without frontmatter", () => {
    const fm = parseFrontmatter("---\na: true\nb: 'yes'\n---\n");
    expect(boolField(fm?.data ?? {}, "a")).toBe(true);
    expect(boolField(fm?.data ?? {}, "b")).toBe(true);
    expect(boolField(fm?.data ?? {}, "c")).toBeUndefined();
    expect(parseFrontmatter("# just a doc")).toBeNull();
  });
  it("loose lists under a key", () => {
    const fm = parseFrontmatter("---\nname: x: y\ntools:\n  - Read\n  - Bash\n---\n");
    expect(listField(fm?.data ?? {}, "tools")).toEqual(["Read", "Bash"]);
  });
});
