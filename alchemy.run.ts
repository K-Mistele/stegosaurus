import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Infisical from "alchemy/Infisical";
import { PkgRegistry } from "@alchemy.run/pkg/Registry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const INFISICAL_PROJECT = "acdc62e9-c2f4-4763-b6a3-80104783759e";

const PROD_STAGE = "prod";

const _storeSecretName = ({ key, stage }: { key: string; stage: string }) => `${key}_${stage}`;

export const Stack = Alchemy.Stack(
  "Everything",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    secrets: ({ stage }) => {
      const infisical = Infisical.Secrets({
        project: INFISICAL_PROJECT,
        environment: stage === PROD_STAGE ? "prod" : "dev",
      });

      return stage === PROD_STAGE ? [infisical] : [infisical, Alchemy.Secrets.DotEnv()];
    },
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const appId = yield* Config.String("GH_APP_ID");
    const privateKey = yield* Config.Redacted("GH_APP_PRIVATE_KEY");

    const store = yield* Cloudflare.SecretsStore.Store("Secrets");

    const githubAppIdSecret = yield* Cloudflare.SecretsStore.Secret("GhAppId", {
      store,
      name: _storeSecretName({ key: "GH_APP_ID", stage }),
      value: Redacted.make(appId),
    });

    const githubPrivateKeySecret = yield* Cloudflare.SecretsStore.Secret("GhAppPrivateKey", {
      store,
      name: _storeSecretName({ key: "GH_APP_PRIVATE_KEY", stage }),
      value: privateKey,
    });

    const pkgOutputs =
      stage === PROD_STAGE
        ? {
            pkgUrl: (yield* PkgRegistry("Pkg", {
              worker: {
                name: "stegosaurus-pkg",
                domain: { name: "pkg.stegosaurus.tech", zoneName: "stegosaurus.tech" },
                workersDev: false,
              },
              github: {
                appId: Config.succeed(appId),
                privateKey: Config.succeed(privateKey),
              },
              policy: {
                repos: ["K-Mistele/stegosaurus"],
              },
            })).url.as<string>(),
          }
        : {};

    return {
      ...pkgOutputs,
      secretsStoreId: store.storeId.as<string>(),
      ghAppIdSecretName: githubAppIdSecret.secretName.as<string>(),
      ghAppPrivateKeySecretName: githubPrivateKeySecret.secretName.as<string>(),
    };
  }),
);

export default Stack;
