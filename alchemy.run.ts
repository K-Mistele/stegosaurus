import * as Alchemy from 'alchemy';
import * as Namespace from 'alchemy/Namespace';
import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Infisical from '@alchemy.run/infisical';
import { PkgRegistry } from '@alchemy.run/pkg/Registry';
import { Agent } from '@stegosaurus/agent';
import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';

const INFISICAL_PROJECT = 'acdc62e9-c2f4-4763-b6a3-80104783759e';

const PROD_STAGE = 'prod';

const _storeSecretName = ({ key, stage }: { key: string; stage: string }) => `${key}_${stage}`;

/**
 * The Infisical names of the config keys the agent's code reads. The code keeps its own names, and so do
 * the Worker secrets alchemy makes from them; only the lookup is renamed. The GitHub App's keys are the
 * ones the rest of the stack uses, and the agent's own keys are prefixed `STEGOSAURUS_`.
 */
const AGENT_SECRET_NAMES = new Map([
    ['GITHUB_APP_ID', 'GH_APP_ID'],
    ['GITHUB_PRIVATE_KEY', 'GH_APP_PRIVATE_KEY'],
    ['GITHUB_WEBHOOK_SECRET', 'STEGOSAURUS_GITHUB_WEBHOOK_SECRET'],
    ['OPENAI_API_KEY', 'STEGOSAURUS_OPENAI_API_KEY'],
]);

/** Look each agent config key up under its Infisical name. Listed last, so it wraps every other source. */
const agentSecretNames = ConfigProvider.layer(
    Effect.map(
        ConfigProvider.ConfigProvider,
        ConfigProvider.mapInput((path) => {
            const renamed = path.length === 1 ? AGENT_SECRET_NAMES.get(String(path[0])) : undefined;

            return renamed === undefined ? path : [renamed];
        }),
    ),
);

export const Stack = Alchemy.Stack(
    'Everything',
    {
        providers: Cloudflare.providers(),
        state: Cloudflare.state(),
        secrets: ({ stage }) => {
            const infisical = Infisical.Secrets({
                project: INFISICAL_PROJECT,
                environment: stage === PROD_STAGE ? 'prod' : 'dev',
            });

            return stage === PROD_STAGE
                ? [infisical, agentSecretNames]
                : [infisical, Alchemy.Secrets.DotEnv(), agentSecretNames];
        },
    },
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;
        const appId = yield* Config.String('GH_APP_ID');
        const privateKey = yield* Config.Redacted('GH_APP_PRIVATE_KEY');

        const store = yield* Cloudflare.SecretsStore.Store('Secrets');

        const githubAppIdSecret = yield* Cloudflare.SecretsStore.Secret('GhAppId', {
            store,
            name: _storeSecretName({ key: 'GH_APP_ID', stage }),
            value: Redacted.make(appId),
        });

        const githubPrivateKeySecret = yield* Cloudflare.SecretsStore.Secret('GhAppPrivateKey', {
            store,
            name: _storeSecretName({ key: 'GH_APP_PRIVATE_KEY', stage }),
            value: privateKey,
        });

        const pkgOutputs =
            stage === PROD_STAGE
                ? {
                      pkgUrl: (yield* PkgRegistry('Pkg', {
                          worker: {
                              name: 'stegosaurus-pkg',
                              domain: { name: 'pkg.stegosaurus.tech', zoneName: 'stegosaurus.tech' },
                              workersDev: false,
                          },
                          github: {
                              appId: Config.succeed(appId),
                              privateKey: Config.succeed(privateKey),
                          },
                          policy: {
                              repos: ['K-Mistele/stegosaurus'],
                          },
                      })).url.as<string>(),
                  }
                : {};

        /** The GitHub coding agent, in every stage. Its resources are recorded under `Agent/`. */
        const agent = yield* Agent.pipe(Namespace.push('Agent'));

        return {
            ...pkgOutputs,
            agentUrl: agent.url.as<string>(),
            secretsStoreId: store.storeId.as<string>(),
            ghAppIdSecretName: githubAppIdSecret.secretName.as<string>(),
            ghAppPrivateKeySecretName: githubPrivateKeySecret.secretName.as<string>(),
        };
    }),
);

export default Stack;
