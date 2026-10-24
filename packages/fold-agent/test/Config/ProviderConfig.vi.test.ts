import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Option, Path } from 'effect';

import { configureProvider, describeModelConfiguration, loadFoldConfig, starterConfigJsonc } from '../../src/index';
import { memoryFileSystem, tempDir } from '../TestHelpers';

/** A fresh temp directory's `config.jsonc` path (the file is not written). */
const tempConfigPath = Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const directory = yield* tempDir;

    return pathService.join(directory, 'config.jsonc');
});

it.effect('adds a provider and model without changing roles, profiles, or policy config', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* tempConfigPath;
            yield* fs.writeFileString(path, starterConfigJsonc());
            const before = yield* loadFoldConfig({ path });

            const updated = yield* configureProvider(
                {
                    name: 'private-openai',
                    kind: 'openai-compat',
                    baseUrl: 'https://models.example.test/v1',
                    apiKey: 'secret-value',
                    model: 'company-model-1',
                },
                { path },
            );

            const persisted = yield* loadFoldConfig({ path });

            expect(updated).toEqual(persisted);
            expect(persisted.roles).toEqual(before.roles);
            expect(persisted.profiles).toEqual(before.profiles);
            expect(persisted.compaction).toEqual(before.compaction);
            expect(persisted.stopConditions).toEqual(before.stopConditions);
            expect(persisted.providers['private-openai']).toEqual({
                kind: 'openai-compat',
                baseUrl: 'https://models.example.test/v1',
                apiKey: 'secret-value',
                configuredModels: ['company-model-1'],
            });
            expect(
                Option.getOrUndefined(
                    Arr.findFirst(
                        describeModelConfiguration(persisted).providers,
                        ({ name }) => name === 'private-openai',
                    ),
                )?.models,
            ).toContain('company-model-1');
            expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('updates a provider, retaining configured models when no new model is supplied', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* tempConfigPath;

            const source = `{
			"providers": {
				"custom": {
					"kind": "openai-compat",
					"baseUrl": "https://old.example/v1",
					"apiKeyEnv": "OLD_KEY",
					"configuredModels": ["existing-model"]
				}
			},
			"roles": {
				"smart": { "provider": "custom", "model": "existing-model" },
				"fast": { "provider": "custom", "model": "existing-model" }
			}
		}`;

            yield* fs.writeFileString(path, source);

            const updated = yield* configureProvider(
                {
                    name: 'custom',
                    kind: 'anthropic',
                    baseUrl: 'https://new.example/v1',
                    apiKey: 'new-key',
                },
                { path },
            );

            expect(updated.providers.custom).toEqual({
                kind: 'anthropic',
                baseUrl: 'https://new.example/v1',
                apiKey: 'new-key',
                configuredModels: ['existing-model'],
            });
            expect(updated.roles.smart).toEqual({ provider: 'custom', model: 'existing-model' });
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('stores an API key environment variable name without resolving or persisting its value', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* tempConfigPath;
            yield* fs.writeFileString(path, starterConfigJsonc());

            const updated = yield* configureProvider(
                {
                    name: 'openrouter',
                    kind: 'openai-compat',
                    baseUrl: 'https://openrouter.ai/api/v1',
                    apiKeyEnv: 'OPENROUTER_API_KEY',
                    model: 'anthropic/claude-sonnet-4',
                },
                { path },
            );

            expect(updated.providers.openrouter).toEqual({
                kind: 'openai-compat',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKeyEnv: 'OPENROUTER_API_KEY',
                configuredModels: ['anthropic/claude-sonnet-4'],
            });
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rejects supplying both inline and environment API key sources', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* tempConfigPath;
            yield* fs.writeFileString(path, starterConfigJsonc());

            const error = yield* configureProvider(
                {
                    name: 'ambiguous',
                    kind: 'anthropic',
                    baseUrl: 'https://api.anthropic.com',
                    apiKey: 'secret',
                    apiKeyEnv: 'ANTHROPIC_API_KEY',
                },
                { path },
            ).pipe(Effect.flip);

            expect(error._tag).toBe('ProviderConfigurationValidationError');
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('adds OAuth profiles without an API key and supplies their default model', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* tempConfigPath;
            yield* fs.writeFileString(path, starterConfigJsonc());

            const updated = yield* configureProvider(
                { name: 'work-codex', kind: 'codex', baseUrl: 'https://example.test' },
                { path },
            );

            expect(updated.providers['work-codex']).toEqual({
                kind: 'codex',
                baseUrl: 'https://example.test',
                configuredModels: ['gpt-6.1-sol'],
            });
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rejects accidental API keys for OAuth profiles before writing', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* tempConfigPath;
            yield* fs.writeFileString(path, starterConfigJsonc());
            const before = yield* fs.readFileString(path);

            const error = yield* configureProvider(
                { name: 'nope', kind: 'xai', baseUrl: 'https://api.x.ai/v1', apiKey: 'secret' },
                { path },
            ).pipe(Effect.flip);

            expect(error._tag).toBe('ProviderConfigurationKindError');
            expect(yield* fs.readFileString(path)).toBe(before);
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('does not replace a malformed existing config', () => {
    const fs = memoryFileSystem({
        '/home/user/.fold/config.jsonc': '{ malformed',
    });

    return Effect.gen(function* () {
        const error = yield* configureProvider(
            { name: 'custom', kind: 'anthropic', baseUrl: 'https://example.test', apiKey: 'secret' },
            { foldHome: '/home/user/.fold' },
        ).pipe(Effect.flip);

        expect(error._tag).toBe('ConfigParseError');
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer));
});
