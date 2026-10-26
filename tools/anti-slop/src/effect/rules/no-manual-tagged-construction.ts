import { defineRule, type ESTree } from "@oxlint/plugins";

import { propertyName } from "../shared/tagged-values.ts";

const isTagProperty = (
	property:
		| ESTree.ObjectProperty
		| ESTree.PropertyDefinition,
): boolean =>
	(property.key.type === "Identifier" && property.key.name === "_tag") ||
	(property.key.type === "Literal" && property.key.value === "_tag");

// `_tag: Schema.tag("X")` / `Schema.tagDefaultOmit("X")` declares a tag field in a schema; it does not build a value.
const isSchemaTagField = (property: ESTree.ObjectProperty): boolean =>
	property.value.type === "CallExpression" &&
	property.value.callee.type === "MemberExpression" &&
	property.value.callee.object.type === "Identifier" &&
	property.value.callee.object.name === "Schema" &&
	property.value.callee.property.type === "Identifier" &&
	property.value.callee.property.name.startsWith("tag");

// `PlatformError.systemError({ _tag: "NotFound", ... })` is Effect's constructor for a SystemError: its
// options name the error's kind with `_tag`, and nothing else takes the kind.
const isSystemErrorOptions = (node: ESTree.ObjectExpression): boolean => {
	const parent = node.parent;
	return (
		parent?.type === "CallExpression" &&
		parent.arguments[0] === node &&
		parent.callee.type === "MemberExpression" &&
		parent.callee.object.type === "Identifier" &&
		parent.callee.object.name === "PlatformError" &&
		parent.callee.property.type === "Identifier" &&
		parent.callee.property.name === "systemError"
	);
};

export const noManualTaggedConstructionRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Construct tagged values with their existing Effect constructor instead of writing `_tag` manually.",
		},
		messages: {
			manualConstruction:
				"Use the existing Schema tagged `.make` or tagged class/error constructor instead of writing a literal `_tag` object.",
			manualDeclaration:
				"Declare tagged classes with Schema.TaggedClass, Schema.TaggedError, Data.TaggedClass, or Data.TaggedError instead of writing a literal `_tag` property.",
		},
	},
	createOnce(context) {
		return {
			ObjectExpression(node) {
				const tag = node.properties.find(
					(property) =>
						property.type === "Property" &&
						propertyName(property) === "_tag",
				);
				if (
					tag !== undefined &&
					!(tag.type === "Property" && isSchemaTagField(tag)) &&
					!isSystemErrorOptions(node)
				) {
					context.report({ node: tag, messageId: "manualConstruction" });
				}
			},
			PropertyDefinition(node) {
				if (isTagProperty(node)) {
					context.report({ node, messageId: "manualDeclaration" });
				}
			},
		};
	},
});
