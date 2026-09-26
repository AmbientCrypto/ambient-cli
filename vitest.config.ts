import { defineConfig } from "vitest/config";

export default defineConfig({
  // The CLI's TUI is authored in TSX; esbuild uses the automatic JSX runtime (matches tsconfig).
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/test/**/*.test.ts", "packages/**/test/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    // Full-app UI tests step through real renders with short waits; on a slow CI runner (Windows especially)
    // a sequence can take longer than the 5s default without anything being wrong.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts", "packages/**/src/**/*.tsx"],
      exclude: ["**/dist/**", "**/*.test.ts", "**/*.test.tsx"],
    },
  },
});
