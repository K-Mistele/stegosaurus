import type { OxlintOverride } from "vite-plus/lint";

/**
 * Per-package lint overrides. Globs resolve from the repo root.
 * Add an entry here rather than a `lint` block in a package's vite.config.ts.
 */
export const overrides = [
  {
    files: ["**/*.test.ts"],
    plugins: ["vitest"],
    rules: {
      // @effect/vitest and alchemy's harness run `expect` inside Effects.
      "vitest/no-standalone-expect": "off",
    },
  },
] satisfies OxlintOverride[];
