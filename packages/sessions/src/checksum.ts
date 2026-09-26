import { createHash } from "node:crypto";
import type { Event } from "@amb/protocol";

/**
 * Canonical serialization for the hash chain: the event WITHOUT its own `checksum`, JSON-stringified
 * with sorted keys so the bytes are stable regardless of property order.
 */
export function canonicalize(event: Omit<Event, "checksum">): string {
  return stableStringify(event);
}

/**
 * The hash chain detects a damaged or hand-edited log (a record changed without re-chaining the rest). It is
 * not a signature: whoever can write the log can recompute it, and nothing is granted from a log's contents.
 */
export function eventChecksum(event: Omit<Event, "checksum">): string {
  return `sha256:${createHash("sha256").update(canonicalize(event), "utf8").digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null"; // never emit the literal "undefined"
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  // Omit keys whose value is undefined — matches JSON.stringify so writer + reader agree.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
