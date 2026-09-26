import { type EvalReport, EvalReportSchema, EvalSuite } from "./types.js";

/** Validate a raw object into an EvalSuite, with a readable error listing every schema violation. */
export function parseSuite(raw: unknown): EvalSuite {
  const result = EvalSuite.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid eval suite: ${issues}`);
  }
  return result.data;
}

/**
 * Parse a suite JSON string (the on-disk `.ambient/evals/<name>.json` format). Untrusted input at a boundary,
 * so JSON errors are surfaced clearly. If the file omits `name`, `fallbackName` (e.g. the filename) fills it in.
 */
export function parseSuiteJson(text: string, fallbackName?: string): EvalSuite {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`eval suite is not valid JSON: ${(e as Error).message}`);
  }
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    fallbackName &&
    (raw as { name?: unknown }).name === undefined
  ) {
    return parseSuite({ ...(raw as object), name: fallbackName });
  }
  return parseSuite(raw);
}

/** Validate a persisted baseline report (untrusted at the read boundary) — never cast raw JSON. */
export function parseReport(raw: unknown): EvalReport {
  const result = EvalReportSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid baseline report: ${issues}`);
  }
  return result.data;
}
