import { defineConfig } from "vite-plus";
import { ignorePatterns } from "./tooling/ignores.ts";
import { antiSlopEffectRules, antiSlopPlugins, antiSlopRules } from "./tooling/lint/anti-slop.ts";
import { effectTsgoPresets, effectTsgoRules } from "./tooling/lint/effect-tsgo.ts";
import { overrides } from "./tooling/lint/overrides.ts";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns,
  },
  lint: {
    extends: effectTsgoPresets,
    ignorePatterns,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }, ...antiSlopPlugins],
    plugins: ["typescript"],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // `Effect.gen` bodies often have no `yield` yet.
      "require-yield": "off",
      ...antiSlopRules,
      ...antiSlopEffectRules,
      ...effectTsgoRules,
    },
    options: { typeAware: true, typeCheck: true },
    overrides,
  },
  test: {
    // Vitest packages only; `test/` and packages/alchemy-test run on Bun via alchemy-test.
    projects: ["apps/*", "tools/*"],
  },
  run: {
    cache: true,
  },
});
