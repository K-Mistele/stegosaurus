import { RuleTester } from "oxlint/plugins-dev";

import { noDisabledTypeAssertionRulesRule } from "./no-disabled-type-assertion-rules.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const disabledRule = { messageId: "disabledRule" };
const disabledEverything = { messageId: "disabledEverything" };

tester.run("anti-slop/no-disabled-type-assertion-rules", noDisabledTypeAssertionRulesRule, {
  valid: [
    "// SAFETY: The parser checked it.\nconst id = value as UserId;",
    "// oxlint-disable-next-line effecttsgo/return-effect-in-gen -- the inner Effect is the result\nconst x = 1;",
    "const x = 1; // eslint-disable-line no-console",
    "/* oxlint-disable no-console */\nconst x = 1;",
    "// This mentions oxlint-disable-next-line automation/no-type-assertion in prose.\nconst x = 1;",
  ],
  invalid: [
    {
      code: "// oxlint-disable-next-line automation/no-type-assertion\nconst id = value as UserId;",
      errors: [disabledRule],
    },
    {
      code: "// oxlint-disable-next-line typescript/consistent-type-assertions, automation/no-type-assertion -- reason\nconst id = value as UserId;",
      errors: [disabledRule, disabledRule],
    },
    {
      code: "const id = value as UserId; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion",
      errors: [disabledRule],
    },
    {
      code: "/* oxlint-disable anti-slop/no-chained-type-assertions */\nconst id = value as unknown as UserId;",
      errors: [disabledRule],
    },
    { code: "// oxlint-disable-next-line\nconst id = value as UserId;", errors: [disabledEverything] },
    { code: "/* eslint-disable */\nconst id = value as UserId;", errors: [disabledEverything] },
    { code: "// oxlint-disable-next-line -- just this once\nconst id = value as UserId;", errors: [disabledEverything] },
  ],
});
