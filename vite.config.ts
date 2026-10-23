import { defineConfig } from "vite-plus";
import { ignorePatterns } from "./tooling/ignores";
import { antiSlopEffectRules, antiSlopPlugins, antiSlopRules } from "./tooling/lint/anti-slop";
import { automationPlugins, automationRules } from "./tooling/lint/automation";
import { builtinCategories, builtinRules } from "./tooling/lint/builtin";
import { effectTsgoPresets, effectTsgoRules } from "./tooling/lint/effect-tsgo";
import { overrides } from "./tooling/lint/overrides";
import { tailwindPlugins, tailwindRules } from "./tooling/lint/tailwind";

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
    plugins: ["typescript", "import"],
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
