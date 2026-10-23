import type { JsPlugin, Rules } from "./types.ts";

export const antiSlopPlugins = [
  { name: "anti-slop", specifier: "./tools/anti-slop/src/index.ts" },
  { name: "anti-slop-effect", specifier: "./tools/anti-slop/src/effect/index.ts" },
] satisfies JsPlugin[];

export const antiSlopRules = {
  "anti-slop/max-ternary-depth": ["error", { maxDepth: 2 }],
  "anti-slop/no-array-filter-map": "error",
  "anti-slop/no-reduce-accumulator-copy": "error",
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-conditional-spread": "error",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-reprovide-ambient-service": "error",
  "anti-slop/no-runtime-typeof": "error",
  "anti-slop/no-shape-in-symbol-names": "error",
  "anti-slop/no-unknown-parameters": "error",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "error",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-readable-spacing": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "error",
} satisfies Rules;

export const antiSlopEffectRules = {
  "anti-slop-effect/no-manual-effect-error-tag": "error",
  "anti-slop-effect/no-manual-tag-comparison": "error",
  "anti-slop-effect/no-manual-tagged-construction": "error",
  "anti-slop-effect/no-manual-tagged-type": "error",
  "anti-slop-effect/no-service-constructor-imports": "error",
  "anti-slop-effect/prefer-effect-match": "error",
  "anti-slop-effect/prefer-tagged-error-handling": "error",
} satisfies Rules;
