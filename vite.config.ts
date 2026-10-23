import { defineConfig } from "vite-plus";
import { ignorePatterns } from "./tooling/ignores.ts";
import { antiSlopEffectRules, antiSlopPlugins, antiSlopRules } from "./tooling/lint/anti-slop.ts";
import { automationPlugins, automationRules } from "./tooling/lint/automation.ts";
import { builtinCategories, builtinRules } from "./tooling/lint/builtin.ts";
import { effectTsgoPresets, effectTsgoRules } from "./tooling/lint/effect-tsgo.ts";
import { overrides } from "./tooling/lint/overrides.ts";
import { tailwindPlugins, tailwindRules } from "./tooling/lint/tailwind.ts";

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
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      ...antiSlopPlugins,
      ...automationPlugins,
      ...tailwindPlugins,
    ],
    plugins: ["typescript"],
    categories: builtinCategories,
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      ...builtinRules,
      ...antiSlopRules,
      ...antiSlopEffectRules,
      ...automationRules,
      ...tailwindRules,
      ...effectTsgoRules,
    },
    options: { typeAware: true, typeCheck: false },
    overrides,
  },
  test: {
    projects: ["apps/*", "tools/*"],
  },
  run: {
    cache: true,
  },
});
