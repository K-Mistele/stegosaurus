import type { OxlintConfig } from "vite-plus/lint";

export type JsPlugin = NonNullable<OxlintConfig["jsPlugins"]>[number];
export type Rules = NonNullable<OxlintConfig["rules"]>;
export type Categories = NonNullable<OxlintConfig["categories"]>;
