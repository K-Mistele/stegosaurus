import type { OxlintOverride } from "vite-plus/lint";

export const overrides = [
  {
    files: ["**/*.test.ts"],
    plugins: ["vitest"],
    rules: {
      "vitest/no-standalone-expect": "off",
    },
  },
] satisfies OxlintOverride[];
