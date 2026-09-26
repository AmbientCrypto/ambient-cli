/**
 * A tiny unified-diff renderer for previewing edits before they are applied. Not a full LCS diff —
 * it shows a hunk of context around each changed region, which is enough for a human to review a
 * targeted search/replace edit. The agent's edits are search/replace, so we diff old vs new content.
 */

export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // Find the common prefix / suffix to bound the changed region.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ctxStart = Math.max(0, start - context);
  const ctxEndA = Math.min(a.length, endA + context);
  const ctxEndB = Math.min(b.length, endB + context);

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  lines.push(`@@ -${ctxStart + 1},${ctxEndA - ctxStart} +${ctxStart + 1},${ctxEndB - ctxStart} @@`);
  for (let i = ctxStart; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i < endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i < endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA; i < ctxEndA; i++) lines.push(` ${a[i]}`);
  return lines.join("\n");
}
