import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { PkgRegistry } from "@alchemy.run/pkg/Registry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const Stack = Alchemy.Stack(
  "Everything",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const pkg = yield* PkgRegistry("Pkg", {
      worker: {
        name: "everything-pkg",
      },
      github: {
        appId: Config.String("GH_APP_ID"),
        privateKey: Config.Redacted("GH_APP_PRIVATE_KEY"),
      },
      policy: {
        repos: ["K-Mistele/everything"],
      },
    });

    return {
      pkgUrl: pkg.url.as<string>(),
    };
  }),
);

export default Stack;
