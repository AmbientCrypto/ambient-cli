import { parse } from "yaml";

/**
 * Frontmatter for skills, agents and commands: a leading `---` fenced YAML block plus the body after it.
 * Parsed as real YAML (lists like `tools: [Read, Write]`, block scalars, quoting); when a file isn't valid
 * YAML — common in the wild, e.g. `description: Use when: …` with an unquoted colon — each `key: value` line
 * is read loosely instead, the way these files are meant to be read.
 */
export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

export function parseFrontmatter(raw: string): Frontmatter | null {
  const text = raw.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const m = FENCE.exec(text);
  if (!m) return null;
  const block = m[1] ?? "";
  const body = text.slice(m[0].length).trim();
  return { data: parseBlock(block), body };
}

function parseBlock(block: string): Record<string, unknown> {
  try {
    const parsed: unknown = parse(block, { maxAliasCount: 10 });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not valid YAML — read it loosely below
  }
  return looseBlock(block);
}

/** `key: value` lines, with `>`/`|` block scalars and `- item` lists; everything after the first colon is the value. */
function looseBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv?.[1]) {
      i++;
      continue;
    }
    const key = kv[1];
    const value = (kv[2] ?? "").trim();
    const folded = /^>[-+]?$/.test(value);
    const literal = /^\|[-+]?$/.test(value);
    if (folded || literal || value === "") {
      const cont: string[] = [];
      i++;
      while (i < lines.length && (/^\s/.test(lines[i] as string) || (lines[i] as string) === "")) {
        cont.push((lines[i] as string).trim());
        i++;
      }
      while (cont.length > 0 && cont[cont.length - 1] === "") cont.pop();
      const items = cont.filter((c) => c.startsWith("- ")).map((c) => unquote(c.slice(2).trim()));
      if (value === "" && items.length > 0 && items.length === cont.filter(Boolean).length) {
        out[key] = items;
      } else {
        out[key] = literal ? cont.join("\n") : cont.join(" ").replace(/\s+/g, " ").trim();
      }
      continue;
    }
    // An inline list `[a, "b"]` in a file that isn't valid YAML elsewhere.
    out[key] = /^\[.*\]$/.test(value)
      ? value
          .slice(1, -1)
          .split(",")
          .map((x) => unquote(x.trim()))
          .filter(Boolean)
      : unquote(value);
    i++;
  }
  return out;
}

const unquote = (s: string) => s.replace(/^(["'])([\s\S]*)\1$/, "$2");

/** A field as trimmed text (numbers and booleans stringified); undefined when absent or empty. */
export function textField(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** A list field: a YAML list, or a string separated by commas or spaces (`Read, Write` / `Read Write`). */
export function listField(data: Record<string, unknown>, key: string): string[] | undefined {
  const v = data[key];
  const items = Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x : String(x)))
    : typeof v === "string"
      ? splitList(v)
      : undefined;
  const clean = items
    ?.map((s) => s.trim().replace(/^[\s"'[]+|[\s"'\]]+$/g, ""))
    .filter((s) => s.length > 0);
  return clean && clean.length > 0 ? clean : undefined;
}

/**
 * Split `a, b c` into items on commas or spaces — except inside parentheses, so a permission-style entry
 * like `Bash(git add:*)` stays one item.
 */
export function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A yes/no field (`true`, `yes`, `on`); undefined when absent. */
export function boolField(data: Record<string, unknown>, key: string): boolean | undefined {
  const v = data[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|yes|on|1)$/i.test(v.trim());
  return undefined;
}
