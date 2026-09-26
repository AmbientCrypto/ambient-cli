import { describe, expect, it } from "vitest";
import { compileGlob } from "../src/glob-match.js";

/** The regex each caller used before (their semantics must not change). */
function oldRegex(glob: string, mode: "any" | "optional-dirs"): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      if (slashAfter && mode === "optional-dirs") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += slashAfter ? 2 : 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

describe("compileGlob", () => {
  it("agrees with the regex it replaces", () => {
    const globs = [
      "**/*.ts",
      "src/*.ts",
      "a/**/b",
      "**",
      "*",
      "?.md",
      "a*b?c",
      "x/**",
      "**/x",
      ".env*",
    ];
    const paths = [
      "a/b/c.ts",
      "src/a.ts",
      "src/a/b.ts",
      "a/b",
      "a/x/y/b",
      "ab",
      "a.md",
      "axbzc",
      "x/y",
      "y/x",
      ".env.local",
      "",
    ];
    for (const mode of ["any", "optional-dirs"] as const) {
      for (const g of globs) {
        const m = compileGlob(g, { doubleStarSlash: mode });
        for (const p of paths)
          expect([mode, g, p, m.test(p)]).toEqual([mode, g, p, oldRegex(g, mode).test(p)]);
      }
    }
  });

  it("stays fast on a pattern that makes a regex backtrack", () => {
    const m = compileGlob(`${"*a".repeat(12)}Z`);
    const started = Date.now();
    expect(m.test("a".repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("can ignore case", () => {
    expect(compileGlob("SRC/*.TS", { caseInsensitive: true }).test("src/a.ts")).toBe(true);
    expect(compileGlob("SRC/*.TS").test("src/a.ts")).toBe(false);
  });
});
