/**
 * Focused persistence boundary used by interactive clients to add or update provider profiles.
 * It deliberately does not edit role bindings: an optional model is registered on the provider so
 * it becomes selectable without unexpectedly changing the user's default/profile behavior.
 */
import { DEFAULT_CODEX_MODEL_ID } from '@stegosaurus/fold-codex';
import { DEFAULT_OPENCODE_MODEL_ID } from '@stegosaurus/fold-opencode';
import { DEFAULT_XAI_MODEL_ID } from '@stegosaurus/fold-xai';
import { Array as Arr, Clock, Effect, FileSystem, Match, Path, Random, Schema, String as Str } from 'effect';

import { FoldConfig, type ProviderKind } from './ConfigSchema';
import {
    configPathFor,
    loadFoldConfig,
    type ConfigDecodeError,
    type ConfigFileNotFoundError,
    type ConfigParseError,
    type LoadConfigOptions,
} from './Load';

/** Values collected by an interactive provider form. OAuth providers must omit `apiKey`. */
export type ConfigureProviderInput = {
    readonly name: string;
    readonly kind: ProviderKind;
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly apiKeyEnv?: string;
    readonly model?: string;
};

/** The provider form contained an empty or invalid value. */
export class ProviderConfigurationValidationError extends Schema.TaggedError<
    ProviderConfigurationValidationError,
    { readonly brand: unique symbol }
>()('ProviderConfigurationValidationError', { field: Schema.String, message: Schema.String }) {}

/** The requested provider kind cannot be safely persisted. */
export class ProviderConfigurationKindError extends Schema.TaggedError<
    ProviderConfigurationKindError,
    { readonly brand: unique symbol }
>()('ProviderConfigurationKindError', { kind: Schema.String, message: Schema.String }) {}

/** The validated config could not be securely persisted. */
export class ProviderConfigurationWriteError extends Schema.TaggedError<
    ProviderConfigurationWriteError,
    { readonly brand: unique symbol }
>()('ProviderConfigurationWriteError', { path: Schema.String, message: Schema.String }) {}

export type ConfigureProviderError =
    | ConfigFileNotFoundError
    | ConfigParseError
    | ConfigDecodeError
    | ProviderConfigurationValidationError
    | ProviderConfigurationKindError
    | ProviderConfigurationWriteError;

const required = (value: string, field: string): Effect.Effect<string, ProviderConfigurationValidationError> => {
    const trimmed = Str.trim(value);

    return trimmed.length === 0
        ? Effect.fail(ProviderConfigurationValidationError.make({ field, message: `${field} must not be empty` }))
        : Effect.succeed(trimmed);
};

const validBaseUrl = (value: string): Effect.Effect<string, ProviderConfigurationValidationError> =>
    required(value, 'baseUrl').pipe(
        Effect.tap((baseUrl) =>
            Effect.try({
                try: () => new URL(baseUrl),
                catch: () =>
                    ProviderConfigurationValidationError.make({ field: 'baseUrl', message: 'baseUrl must be a URL' }),
            }).pipe(
                Effect.filterOrFail(
                    (url) => url.protocol === 'http:' || url.protocol === 'https:',
                    () =>
                        ProviderConfigurationValidationError.make({
                            field: 'baseUrl',
                            message: 'baseUrl must use http or https',
                        }),
                ),
            ),
        ),
    );

/** The connection's credential field: none for OAuth providers, otherwise exactly one of the two. */
const resolveCredentials = (input: ConfigureProviderInput) =>
    Effect.gen(function* () {
        const oauth = input.kind === 'codex' || input.kind === 'opencode' || input.kind === 'xai';
        const hasApiKey = input.apiKey !== undefined && Str.trim(input.apiKey) !== '';
        const hasApiKeyEnv = input.apiKeyEnv !== undefined && Str.trim(input.apiKeyEnv) !== '';

        if (oauth && (hasApiKey || hasApiKeyEnv))
            return yield* ProviderConfigurationKindError.make({
                kind: input.kind,
                message: `${input.kind} credentials are OAuth-managed; API key options must not be supplied`,
            });

        if (!oauth && hasApiKey === hasApiKeyEnv)
            return yield* ProviderConfigurationValidationError.make({
                field: 'apiKey',
                message: 'supply exactly one of apiKey or apiKeyEnv',
            });

        if (oauth) return {};

        return hasApiKey
            ? { apiKey: yield* required(input.apiKey ?? '', 'apiKey') }
            : { apiKeyEnv: yield* required(input.apiKeyEnv ?? '', 'apiKeyEnv') };
    });

const encodeConfigText = Schema.encodeEffect(Schema.fromJsonString(FoldConfig, { space: '\t' }));

const writeConfig = (
    config: FoldConfig,
    options: LoadConfigOptions | undefined,
): Effect.Effect<void, ProviderConfigurationWriteError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const path = configPathFor(options);
        // A unique temp path for the atomic write-rename. Clock/Random are the seams here (not Date.now/crypto),
        // so a test can pin the temporary filename deterministically.
        const now = yield* Clock.currentTimeMillis;
        const salt = Str.slice(2)((yield* Random.next).toString(36));
        const temporaryPath = `${path}.tmp-${process.pid}-${now}-${salt}`;

        const text = `${yield* encodeConfigText(config).pipe(
            Effect.mapError((error) =>
                ProviderConfigurationWriteError.make({ path, message: `could not encode config: ${error.message}` }),
            ),
        )}\n`;

        const writeDirect = fs.writeFileString(path, text, { mode: 0o600 }).pipe(Effect.andThen(fs.chmod(path, 0o600)));

        return yield* fs.makeDirectory(pathService.dirname(path), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(temporaryPath, text, { mode: 0o600 })),
            Effect.andThen(fs.chmod(temporaryPath, 0o600)),
            Effect.andThen(fs.rename(temporaryPath, path)),
            Effect.andThen(fs.chmod(path, 0o600)),
            // Some injected/sandbox filesystems do not implement rename. A mode-restricted direct write is
            // still reasonable there; clean up the temporary file on either fallback outcome.
            Effect.catch(() => writeDirect.pipe(Effect.ensuring(fs.remove(temporaryPath).pipe(Effect.ignore)))),
            Effect.mapError((error) =>
                ProviderConfigurationWriteError.make({ path, message: `could not write config: ${error.message}` }),
            ),
        );
    });

/**
 * Add or replace an Anthropic/OpenAI-compatible connection, preserving every other decoded config
 * field. If `model` is supplied it is appended to `configuredModels`; roles are never modified.
 */
export const configureProvider = (
    input: ConfigureProviderInput,
    options: LoadConfigOptions | undefined,
): Effect.Effect<FoldConfig, ConfigureProviderError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const name = yield* required(input.name, 'name');
        const baseUrl = yield* validBaseUrl(input.baseUrl);
        const credential = yield* resolveCredentials(input);

        const defaultModel = Match.value(input.kind).pipe(
            Match.when('codex', () => DEFAULT_CODEX_MODEL_ID),
            Match.when('opencode', () => DEFAULT_OPENCODE_MODEL_ID),
            Match.when('xai', () => DEFAULT_XAI_MODEL_ID),
            Match.orElse(() => undefined),
        );

        const model = input.model === undefined ? defaultModel : yield* required(input.model, 'model');
        const config = yield* loadFoldConfig(options);
        const previousModels = config.providers[name]?.configuredModels ?? [];
        const configuredModels = model === undefined ? previousModels : [...new Set([...previousModels, model])];
        const connection = { kind: input.kind, baseUrl, ...credential };

        const provider = Arr.isReadonlyArrayNonEmpty(configuredModels)
            ? { ...connection, configuredModels }
            : connection;

        const updated: FoldConfig = { ...config, providers: { ...config.providers, [name]: provider } };

        yield* writeConfig(updated, options);

        return updated;
    }).pipe(Effect.withSpan('config.configure_provider', { attributes: { provider: input.name, kind: input.kind } }));
