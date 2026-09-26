/**
 * A small subsequence fuzzy matcher for the command menu and the @file picker: every query character must
 * appear in order; matches at the start, after a separator (/ - _ . space) or at a camelCase hump score
 * higher, and consecutive runs score higher still. Returns undefined when the query doesn't match.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
  const q = query.toLowerCase();
  if (q.length === 0) return 0;
  const c = candidate.toLowerCase();
  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] !== q[qi]) continue;
    let s = 1;
    const before = candidate[i - 1];
    if (i === 0) s += 8;
    else if (before !== undefined && /[\/\-_. :]/.test(before)) s += 6;
    else if (before !== undefined && /[a-z]/.test(before) && /[A-Z]/.test(candidate[i] ?? ""))
      s += 4;
    if (prev === i - 1) s += 5;
    score += s;
    prev = i;
    qi++;
  }
  if (qi < q.length) return undefined;
  // Prefer shorter candidates and an exact prefix.
  return score + (c.startsWith(q) ? 10 : 0) - candidate.length * 0.05;
}

/** Rank `items` by fuzzy match of `query` against `key(item)`, best first; non-matches are dropped. */
export function fuzzyRank<T>(query: string, items: readonly T[], key: (t: T) => string): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
