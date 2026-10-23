import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { Stack } from "../alchemy.run.ts";

// Runs the Worker in local workerd with local state; set dev: false to deploy for real.
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const stack = beforeAll(deploy(Stack));
afterAll(destroy(Stack));

test(
  "backend responds",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const res = yield* HttpClient.get(backendUrl);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("Hello from the backend");
  }),
);
