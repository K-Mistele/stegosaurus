import { expect, it } from '@effect/vitest';
import type { ModelCatalogEntry } from '@stegosaurus/fold-core';
import { Array as Arr, Effect, Option, Schema } from 'effect';

import {
    ConfiguredModelSelection,
    describeModelConfiguration,
    type ModelConfiguration,
    parseFoldConfig,
    resolveConfiguredModelSelection,
} from '../../src/index';

const configText = `{
	"providers": {
		"claude": { "kind": "anthropic", "apiKey": "super-secret" },
		"codex": { "kind": "codex" }
	},
	"roles": {
		"smart": { "provider": "claude", "model": "default-smart" },
		"fast": { "provider": "codex", "model": "default-fast" }
	},
	"profiles": {
		"named": {
			"smart": { "provider": "codex", "model": "profile-smart" },
			"fast": { "provider": "codex", "model": "profile-fast" },
			"orchestrator": { "provider": "codex", "model": "profile-orchestrator" },
			"mode": "rlm"
		}
	}
}`;

const catalog: ReadonlyArray<ModelCatalogEntry> = [
    {
        providerId: 'codex',
        modelId: 'catalog-only',
        name: null,
        contextWindow: 100_000,
        maxInputTokens: null,
        maxOutputTokens: 10_000,
        reasoning: true,
        reasoningEfforts: null,
        vision: false,
        toolCall: true,
        pricing: null,
    },
];

const catalogEntry = (providerId: string, modelId: string): ModelCatalogEntry => {
    const entry = catalog[0];

    if (entry === undefined) throw new Error('Expected catalog fixture');

    return { ...entry, providerId, modelId };
};

const providerNamed = (description: ModelConfiguration, providerName: string) =>
    Option.getOrUndefined(Arr.findFirst(description.providers, ({ name }) => name === providerName));

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect('resolves default and named profiles', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(configText, undefined);

        const defaultModels = yield* resolveConfiguredModelSelection(
            config,
            ConfiguredModelSelection.profile({ profile: 'default' }),
            'default',
            undefined,
        );

        const namedModels = yield* resolveConfiguredModelSelection(
            config,
            ConfiguredModelSelection.profile({ profile: 'named' }),
            'default',
            undefined,
        );

        const namedInCurrentRlmMode = yield* resolveConfiguredModelSelection(
            config,
            ConfiguredModelSelection.profile({ profile: 'named' }),
            'rlm',
            undefined,
        );

        expect(defaultModels.root.activeModel.modelId).toBe('default-smart');
        expect(defaultModels.fast.activeModel.modelId).toBe('default-fast');
        expect(namedModels.smart.activeModel.modelId).toBe('profile-smart');
        expect(namedModels.fast.activeModel.modelId).toBe('profile-fast');
        expect(namedInCurrentRlmMode.root.activeModel.modelId).toBe('profile-orchestrator');
        expect(namedInCurrentRlmMode.smart.activeModel.modelId).toBe('profile-smart');
    }),
);

it.effect('applies provider-specific role defaults around the directly selected root model', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(configText, undefined);
        const direct = ConfiguredModelSelection.direct({ provider: 'codex', model: 'chosen' });
        const normal = yield* resolveConfiguredModelSelection(config, direct, 'default', undefined);
        const rlm = yield* resolveConfiguredModelSelection(config, direct, 'rlm', undefined);

        expect(normal.root.activeModel.modelId).toBe('chosen');
        expect(normal.root.activeModel.role).toBe('smart');
        expect(normal.smart.activeModel.modelId).toBe('chosen');
        expect(normal.fast.activeModel).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.6-luna' });
        expect(normal.orchestrator.activeModel).toMatchObject({ providerId: 'codex', modelId: 'gpt-6.1-sol' });
        expect(rlm.root.activeModel.modelId).toBe('chosen');
        expect(rlm.root.activeModel.role).toBe('orchestrator');
        expect(rlm.smart.activeModel).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.6-terra' });
        expect(rlm.fast.activeModel).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.6-luna' });
    }),
);

it.effect('a direct Codex choice does not resolve unrelated Anthropic role credentials', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(
            `{
			"providers": {
				"anthropic": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
				"codex": { "kind": "codex" }
			},
			"roles": {
				"smart": { "provider": "anthropic" },
				"fast": { "provider": "anthropic" },
				"orchestrator": { "provider": "anthropic" }
			}
		}`,
            undefined,
        );

        const models = yield* resolveConfiguredModelSelection(
            config,
            ConfiguredModelSelection.direct({ provider: 'codex', model: 'gpt-5.6-sol' }),
            'default',
            { env: () => undefined },
        );

        expect(
            Arr.every(
                [models.root, models.smart, models.fast, models.orchestrator],
                (model) => model.activeModel.providerId === 'codex',
            ),
        ).toBe(true);
    }),
);

it.effect('uses Anthropic defaults for a direct Anthropic choice', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(configText, undefined);

        const models = yield* resolveConfiguredModelSelection(
            config,
            ConfiguredModelSelection.direct({ provider: 'claude', model: 'claude-selected' }),
            'default',
            undefined,
        );

        expect(models.smart.activeModel.modelId).toBe('claude-selected');
        expect(models.orchestrator.activeModel.modelId).toBe('claude-opus-4-8');
        expect(models.fast.activeModel.modelId).toBe('claude-sonnet-5');
        expect(
            Arr.every(
                [models.smart, models.fast, models.orchestrator],
                (model) => model.activeModel.providerId === 'claude',
            ),
        ).toBe(true);
    }),
);

it.effect('rejects an unknown profile', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(configText, undefined);

        const error = yield* resolveConfiguredModelSelection(
            config,
            ConfiguredModelSelection.profile({ profile: 'missing' }),
            'default',
            undefined,
        ).pipe(Effect.flip);

        expect(error.message).toContain('unknown model profile "missing"');
    }),
);

it.effect('describes profiles, credentials, and merged model candidates without secrets', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(configText, undefined);
        const description = describeModelConfiguration(config, catalog);

        expect(description.profiles).toContainEqual({ name: 'named', mode: 'rlm' });
        expect(providerNamed(description, 'claude')?.credentialPresent).toBe(true);
        expect(providerNamed(description, 'codex')?.models).toEqual([
            'catalog-only',
            'default-fast',
            'gpt-6.1-sol',
            'profile-fast',
            'profile-orchestrator',
            'profile-smart',
        ]);
        expect(yield* encodeJsonText(description)).not.toContain('super-secret');
        expect(description).not.toHaveProperty('config');
    }),
);

it.effect('always exposes Grok Build for an OpenCode provider without catalog data', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(
            `{
			"providers": { "zen": { "kind": "opencode" } },
			"roles": { "smart": { "provider": "zen" }, "fast": { "provider": "zen" } }
		}`,
            undefined,
        );

        expect(describeModelConfiguration(config).providers[0]?.models).toEqual(['gpt-5.6-sol', 'grok-build-0.1']);
    }),
);

it.effect('maps catalog provider ids through configured provider aliases', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(
            `{
			"providers": {
				"claude-alias": { "kind": "anthropic", "apiKey": "x" },
				"codex-alias": { "kind": "codex" },
				"proxy": { "kind": "openai-compat", "baseUrl": "https://example.test", "apiKey": "x" }
			},
			"roles": {
				"smart": { "provider": "claude-alias", "model": "claude" },
				"fast": { "provider": "proxy", "model": "gpt" }
			}
		}`,
            undefined,
        );

        const description = describeModelConfiguration(config, [
            catalogEntry('anthropic', 'anthropic-catalog'),
            catalogEntry('openai', 'openai-catalog'),
            catalogEntry('proxy', 'proxy-catalog'),
        ]);

        expect(providerNamed(description, 'claude-alias')?.models).toContain('anthropic-catalog');
        expect(providerNamed(description, 'codex-alias')?.models).toContain('openai-catalog');
        expect(providerNamed(description, 'proxy')?.models).toEqual(
            expect.arrayContaining(['openai-catalog', 'proxy-catalog']),
        );
    }),
);

it.effect('provides OAuth defaults when the external catalog is unavailable', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(
            `{
			"providers": { "zen": { "kind": "opencode" }, "grok": { "kind": "xai" } },
			"roles": { "smart": { "provider": "zen" }, "fast": { "provider": "grok" } }
		}`,
            undefined,
        );

        const description = describeModelConfiguration(config, []);
        expect(providerNamed(description, 'zen')).toMatchObject({
            credentialPresent: null,
            models: ['gpt-5.6-sol', 'grok-build-0.1'],
        });
        expect(providerNamed(description, 'grok')).toMatchObject({
            credentialPresent: null,
            models: ['grok-4.5', 'grok-4.6'],
        });
    }),
);

it.effect('merges configured, role-bound, and catalog models for xAI providers', () =>
    Effect.gen(function* () {
        const config = yield* parseFoldConfig(
            `{
			"providers": { "grok": { "kind": "xai", "configuredModels": ["grok-3", "grok-4"] } },
			"roles": {
				"smart": { "provider": "grok", "model": "grok-4" },
				"fast": { "provider": "grok", "model": "grok-3" }
			}
		}`,
            undefined,
        );

        const description = describeModelConfiguration(config, [catalogEntry('xai', 'grok-2')]);
        expect(description.providers[0]?.models).toEqual(['grok-2', 'grok-3', 'grok-4', 'grok-4.5', 'grok-4.6']);
    }),
);
