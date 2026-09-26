import { createInterface } from "node:readline/promises";
import type { AskPort } from "@amb/runtime";
import { bold, dim } from "../render/color.js";

/**
 * Interactive questionnaire for the LINE UI (backs `ask_user`) — prints the question + numbered options and
 * reads one line: leading number(s) pick option(s), the remainder is a free-text note. Only wired when stdin
 * is a TTY (a piped/scripted run gets no asker at all, so the tool returns its proceed-on-best-judgment note).
 */
export function makeInteractiveAsker(): AskPort {
  return async (req) => {
    const options = req.options ?? [];
    const multi = req.multiSelect === true;
    const allowText = req.allowText !== false;

    process.stderr.write(`\n${bold(`? ${req.question}`)}\n`);
    options.forEach((o, i) => {
      const desc = o.description ? dim(`  — ${o.description}`) : "";
      process.stderr.write(`  ${dim(`[${i + 1}]`)} ${o.label}${desc}\n`);
    });
    const hint =
      options.length > 0
        ? `  ${multi ? "numbers (comma-separated)" : "a number"}${allowText ? " and/or a note" : ""} · enter to skip > `
        : "  your answer · enter to skip > ";

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const raw = (await rl.question(hint)).trim();
      if (raw.length === 0) return { selected: [], cancelled: true };

      // No options → the whole line is the answer text.
      if (options.length === 0) return { selected: [], text: raw };

      // Consume a leading "1,2 3" number list as selections; the rest is a note.
      const idxs: number[] = [];
      let rest = raw;
      const m = raw.match(/^[\s,]*((?:\d+[\s,]*)+)/);
      if (m?.[1]) {
        for (const t of m[1].split(/[\s,]+/)) {
          const n = Number(t);
          if (Number.isInteger(n) && n >= 1 && n <= options.length && !idxs.includes(n - 1)) {
            idxs.push(n - 1);
          }
        }
        rest = raw.slice(m[0].length).trim();
      }
      const picked = multi ? idxs : idxs.slice(0, 1); // single-select keeps only the first number
      const selected = picked.map((i) => options[i]?.label).filter((l): l is string => Boolean(l));
      return { selected, ...(rest ? { text: rest } : {}) };
    } finally {
      rl.close();
    }
  };
}
