// Glob matching in linear time. A glob compiled to a JavaScript RegExp (`*a*a*a…b`) can backtrack for
// minutes on a long path, and a regex can't be interrupted; this runs the pattern as a small state machine
// instead, so matching costs at most (path length × pattern length) steps whatever the pattern.
//
// `*` matches within one path segment, `?` one character other than `/`, `**` anything including `/`.
// When `**` is followed by `/`:
//  - "optional-dirs": `a/**/b` matches `a/b` and `a/x/y/b` (zero or more whole folders),
//  - "any" (the default): the `/` folds into `**`, so `a/**/b` matches `a/`, then anything, then `b`.
export interface GlobOptions {
  doubleStarSlash?: "optional-dirs" | "any";
  caseInsensitive?: boolean;
}

export interface GlobMatcher {
  test(path: string): boolean;
}

interface State {
  /** Transitions that consume one character. */
  edges: Array<{ accepts: (ch: string) => boolean; to: number }>;
  /** Transitions that consume nothing. */
  skips: number[];
}

const anyChar = () => true;
const notSlash = (ch: string) => ch !== "/";

export function compileGlob(pattern: string, opts: GlobOptions = {}): GlobMatcher {
  const fold = (s: string) => (opts.caseInsensitive ? s.toLowerCase() : s);
  const glob = fold(pattern);
  const states: State[] = [{ edges: [], skips: [] }];
  const add = () => states.push({ edges: [], skips: [] }) - 1;
  let cur = 0;
  // A new state reached from `cur` without consuming, which then loops on `accepts`.
  const loop = (accepts: (ch: string) => boolean) => {
    const n = add();
    (states[cur] as State).skips.push(n);
    (states[n] as State).edges.push({ accepts, to: n });
    cur = n;
  };
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      if (slashAfter && opts.doubleStarSlash === "optional-dirs") {
        // (anything ending in "/")? — either skip it, or loop on anything and then take a "/".
        const inner = add();
        const end = add();
        (states[cur] as State).skips.push(end, inner);
        (states[inner] as State).edges.push({ accepts: anyChar, to: inner });
        (states[inner] as State).edges.push({ accepts: (ch) => ch === "/", to: end });
        cur = end;
        i += 2;
      } else {
        loop(anyChar);
        i += slashAfter ? 2 : 1;
      }
    } else if (c === "*") loop(notSlash);
    else {
      const n = add();
      const accepts = c === "?" ? notSlash : (ch: string) => ch === c;
      (states[cur] as State).edges.push({ accepts, to: n });
      cur = n;
    }
  }
  const accept = cur;

  const closure = (set: Set<number>) => {
    const stack = [...set];
    while (stack.length > 0) {
      const s = stack.pop() as number;
      for (const t of (states[s] as State).skips) {
        if (!set.has(t)) {
          set.add(t);
          stack.push(t);
        }
      }
    }
    return set;
  };

  return {
    test(path: string): boolean {
      let active = closure(new Set([0]));
      for (const ch of fold(path)) {
        const next = new Set<number>();
        for (const s of active) {
          for (const e of (states[s] as State).edges) if (e.accepts(ch)) next.add(e.to);
        }
        if (next.size === 0) return false;
        active = closure(next);
      }
      return active.has(accept);
    },
  };
}
