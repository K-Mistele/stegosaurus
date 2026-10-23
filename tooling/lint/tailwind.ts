import type { JsPlugin, Rules } from "./types.ts";

export const tailwindPlugins = [
  { name: "better-tailwindcss", specifier: "eslint-plugin-better-tailwindcss" },
] satisfies JsPlugin[];

export const tailwindRules = {
  "better-tailwindcss/no-concatenated-classes": "error",
  "better-tailwindcss/no-conflicting-classes": "error",
  "better-tailwindcss/no-deprecated-classes": "error",
  "better-tailwindcss/no-duplicate-classes": "error",
  "better-tailwindcss/no-restricted-classes": ["error", { restrict: ["\\\\[[^\\\\]]+\\\\]"] }],
  "better-tailwindcss/no-unknown-classes": "error",
} satisfies Rules;
