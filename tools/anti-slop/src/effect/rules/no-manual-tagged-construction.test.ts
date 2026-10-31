import { RuleTester } from "oxlint/plugins-dev";

import { noManualTaggedConstructionRule } from "./no-manual-tagged-construction.ts";

new RuleTester().run(
	"no-manual-tagged-construction",
	noManualTaggedConstructionRule,
	{
		valid: [
			'Match.value(value).pipe(Match.tag("Ready", handleReady));',
			"Ready.make({ value });",
			"new NotFound({ id });",
			'Schema.Struct({ _tag: Schema.tag("Ready"), value: Schema.String });',
			'Schema.Struct({ _tag: Schema.tagDefaultOmit("Granted"), token: Schema.String });',
			'PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readFile" });',
		],
		invalid: [
			{
				code: 'const value = { _tag: "Ready", payload };',
				errors: [{ messageId: "manualConstruction" }],
			},
			{
				code: 'const value = { ["_tag"]: "Ready" };',
				errors: [{ messageId: "manualConstruction" }],
			},
			{
				code: 'const value = { _tag: tag, payload };',
				errors: [{ messageId: "manualConstruction" }],
			},
			{
				filename: "value.ts",
				code: 'const value = { _tag: "Ready" as const, payload };',
				errors: [{ messageId: "manualConstruction" }],
			},
			{
				code: 'const value = { _tag: Other.tag("Ready") };',
				errors: [{ messageId: "manualConstruction" }],
			},
			{
				code: 'PlatformError.badArgument({ _tag: "Ready", module: "FileSystem", method: "readFile" });',
				errors: [{ messageId: "manualConstruction" }],
			},
			{
				code: 'Match.when({ _tag: "Ready" }, handleReady);',
				errors: [{ messageId: "manualConstruction" }],
			},
			{
				code: 'Match.not({ "_tag": "Pending" });',
				errors: [{ messageId: "manualConstruction" }],
			},
			{
				filename: "value.ts",
				code: 'class Value { readonly _tag = "Ready"; }',
				errors: [{ messageId: "manualDeclaration" }],
			},
		],
	},
);
