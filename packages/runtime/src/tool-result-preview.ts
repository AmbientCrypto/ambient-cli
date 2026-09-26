/**
 * Turn a tool's STRUCTURED result into a short, human-readable, multi-line preview for the `tool.result`
 * event — the text the UIs show under a tool row. It emits REAL newlines and the salient human field per
 * tool (read → file contents, bash → stdout/stderr, grep → file:line: text, …). It must NEVER dump a raw
 * `JSON.stringify(result)` envelope (the old behaviour) — that produced the unreadable `{"path":…,"content":
 * "1\t…"}` wall with escaped \t/\n that runs off the screen.
 *
 * Pure and presentation-neutral (no colour, no width): the preview rides on the event, so it is bounded here
 * to keep the durable log small; the shell decides final wrapping/spacing.
 */

/** Max lines kept in a preview (the shell shows all of them; long output is summarised with a marker). */
export const PREVIEW_MAX_LINES = 8;
/** Hard character ceiling for a preview (keeps the event log small even for one very long line). */
export const PREVIEW_MAX_CHARS = 700;

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Cap a body by lines first, then chars, appending an honest elision marker reflecting the FULL body. */
function cap(body: string): string {
  const trimmed = body.replace(/\s+$/, "");
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const kept = lines.slice(0, PREVIEW_MAX_LINES);
  const droppedLines = lines.length - kept.length;
  let out = kept.join("\n");
  if (out.length > PREVIEW_MAX_CHARS) {
    out = `${out.slice(0, PREVIEW_MAX_CHARS)} …`;
  } else if (droppedLines > 0) {
    out += `\n… (+${droppedLines} more line${droppedLines === 1 ? "" : "s"})`;
  }
  return out;
}

/**
 * @param toolName the manifest tool name (read/bash/grep/…)
 * @param result   the tool's raw result value
 * @param error    the tool's error string, if it failed
 * @returns a bounded human-readable preview, or undefined when there is nothing worth showing
 */
export function previewResult(
  toolName: string,
  result: unknown,
  error?: string,
): string | undefined {
  if (error) return error.slice(0, PREVIEW_MAX_CHARS) || undefined;
  const r = asObject(result);

  switch (toolName) {
    case "read": {
      const content = asString(r?.content);
      return content ? cap(content) : "(empty file)";
    }
    case "bash": {
      const out = asString(r?.stdout).replace(/\s+$/, "");
      const err = asString(r?.stderr).replace(/\s+$/, "");
      const exit = typeof r?.exitCode === "number" ? r.exitCode : null;
      const timedOut = r?.timedOut === true;
      const failed = timedOut || (exit !== null && exit !== 0);
      const status: string[] = [];
      if (exit !== null && exit !== 0) status.push(`exit ${exit}`);
      if (timedOut) status.push("(timed out)");
      const errLine = err ? `stderr: ${err}` : "";
      // On FAILURE lead with the signal that matters (exit + stderr) so the line cap can't bury it under a
      // long stdout; on success show stdout first (stderr still labelled if the command also wrote to it).
      const parts = failed ? [status.join(" "), errLine, out] : [out, errLine];
      const body = parts.filter(Boolean).join("\n");
      return body ? cap(body) : "(no output)";
    }
    case "grep": {
      const matches = Array.isArray(r?.matches) ? r.matches : [];
      if (matches.length === 0) return "no matches";
      const lines = matches.map((m) => {
        const mm = asObject(m) ?? {};
        const line = typeof mm.line === "number" ? mm.line : "?";
        return `${asString(mm.file)}:${line}: ${asString(mm.text).trim()}`;
      });
      return cap(lines.join("\n"));
    }
    case "glob": {
      const matches = Array.isArray(r?.matches) ? r.matches.map((m) => asString(m)) : [];
      // A soft time-budget stop returns partials — say so plainly instead of looking like a complete result.
      const note = r?.timedOut === true ? " (searched a lot — partial results)" : "";
      if (matches.length === 0)
        return r?.timedOut === true ? "no matches yet (timed out)" : "no files matched";
      return `${cap(matches.join("\n"))}${note}`;
    }
    case "list": {
      // A missing directory is a soft, expected result (the model probed for a path) — calm, not a crash.
      if (r?.notFound === true) return "(directory not found)";
      const entries = Array.isArray(r?.entries) ? r.entries : [];
      if (entries.length === 0) return "(empty)";
      const names = entries.map((e) => {
        const ee = asObject(e) ?? {};
        return asString(ee.name) + (ee.dir === true ? "/" : "");
      });
      // One entry per line so cap()'s honest "+N more lines" marker fires (a two-space join is one "line"
      // to cap(), which would silently cut mid-filename with no count of what was omitted).
      return cap(names.join("\n"));
    }
    case "web_fetch": {
      const status = typeof r?.status === "number" ? `[${r.status}]` : "";
      const head = [status, asString(r?.title)].filter(Boolean).join(" ");
      return cap([head, asString(r?.text)].filter(Boolean).join("\n"));
    }
    case "web_search": {
      const results = Array.isArray(r?.results) ? r.results : [];
      const lines = results
        .map((x) => {
          const xx = asObject(x) ?? {};
          // filter first so a result missing a title (or url) never emits a stray " — " / dash-only line
          return [asString(xx.title), asString(xx.url)].filter(Boolean).join(" — ");
        })
        .filter((l) => l.length > 0);
      if (lines.length === 0) return asString(r?.note) || "no results";
      return cap(lines.join("\n"));
    }
    default: {
      // Unknown/other tools: prefer a human text field; else a terse scalar summary — never a JSON envelope.
      if (typeof result === "string") return cap(result) || undefined;
      if (r) {
        for (const k of ["message", "text", "content", "summary", "stdout", "note"]) {
          const v = asString(r[k]);
          if (v) return cap(v);
        }
        const scalars = Object.entries(r)
          .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
          .slice(0, 4)
          .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`);
        return scalars.length ? cap(scalars.join("  ")) : undefined;
      }
      return undefined;
    }
  }
}
