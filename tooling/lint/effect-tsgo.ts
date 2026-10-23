import { presets } from "@effect/tsgo/oxlint-presets";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Struct from "effect/Struct";

/** Every @effect/tsgo preset; needs `effect-tsgo patch --oxlint` (run by `prepare`). */
export const effectTsgoPresets = Record.values(presets);

const effectTsgoRuleNames = Arr.flatMap(effectTsgoPresets, (preset) =>
  Struct.keys(preset.rules ?? {}),
);

/** Promote every diagnostic to an error, with a few rules turned off. */
export const effectTsgoRules = {
  ...Record.fromEntries(Arr.map(effectTsgoRuleNames, (rule) => [rule, "error"] as const)),
  // Demands Effect-style data-last overloads on every exported multi-argument function.
  "effecttsgo/missing-pipeable-signature": "off",
  // We build on Effect APIs marked unstable (effect/http, @effect/vitest, alchemy).
  "effecttsgo/unstable-api-usage": "off",
  "effecttsgo/api-stability-leak": "off",
} as const;
