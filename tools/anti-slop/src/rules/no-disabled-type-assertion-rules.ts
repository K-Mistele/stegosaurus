import { defineRule } from "@oxlint/plugins";

/** The rules that keep type assertions out. An inline disable of any of them lets a cast through. */
const typeAssertionRules = new Set([
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-widen-then-assert",
  "anti-slop/require-safety-comment-for-type-assertion",
  "automation/no-banned-type-assertions",
  "automation/no-type-assertion",
  "effecttsgo/unsafe-effect-type-assertion",
  "typescript/consistent-type-assertions",
  "typescript/no-unsafe-type-assertion",
]);

const directivePattern = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?=\s|$)(.*)$/su;

/** The rule names a disable directive lists, with `@typescript-eslint/` read as `typescript/`. */
function directiveRules(value: string): readonly string[] | null {
  const match = directivePattern.exec(value);
  if (match === null) return null;
  const list = (match[1] ?? "").split(/\s--\s|\s--$/u)[0] ?? "";
  return list
    .split(",")
    .map((rule) => rule.trim().replace(/^@?typescript-eslint\//u, "typescript/"))
    .filter((rule) => rule.length > 0);
}

/** Disallow inline disables of the type-assertion rules, and disables that name no rule at all. */
export const noDisabledTypeAssertionRulesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow inline disable comments for the type-assertion rules, and disable comments that name no rule.",
    },
    messages: {
      disabledRule:
        "Don't disable `{{rule}}` inline. Remove the cast, or add a file override with its reason in the lint config.",
      disabledEverything:
        "This disable comment names no rule, so it turns off the type-assertion rules too. Name the rules it disables.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const rules = directiveRules(comment.value);
          if (rules === null) continue;
          if (rules.length === 0) {
            context.report({ node: comment, messageId: "disabledEverything" });
            continue;
          }
          for (const rule of rules) {
            if (!typeAssertionRules.has(rule)) continue;
            context.report({ node: comment, messageId: "disabledRule", data: { rule } });
          }
        }
      },
    };
  },
});
