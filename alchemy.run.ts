import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Service from "./apps/backend/src/Service.ts";

export const Stack = Alchemy.Stack(
  "Everything",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const backend = yield* Service;

    return {
      backendUrl: backend.url.as<string>(),
    };
  }),
);

export default Stack;
