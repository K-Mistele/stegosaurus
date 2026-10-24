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
				if (tag !== undefined && !(tag.type === "Property" && isSchemaTagField(tag))) {
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
