import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Alchemy";
import { Stack } from "../alchemy.run.ts";

const { beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

export const stack = beforeAll(deploy(Stack));
afterAll(destroy(Stack));
