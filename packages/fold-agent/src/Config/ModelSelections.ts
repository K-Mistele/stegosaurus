import { DEFAULT_CODEX_MODEL_ID } from '@stegosaurus/fold-codex';
import { DEFAULT_ANTHROPIC_MODEL_ID, type ModelCatalogEntry, type FoldModel } from '@stegosaurus/fold-core';
import { DEFAULT_OPENCODE_MODEL_ID, GROK_BUILD_MODEL_ID } from '@stegosaurus/fold-opencode';
import { DEFAULT_XAI_MODEL_ID, XAI_FRONTIER_MODELS } from '@stegosaurus/fold-xai';
import { Array as Arr, Data, Effect, type FileSystem, Match, type Path, Predicate, Record } from 'effect';
import type { HttpClient } from 'effect/http';

import { agentModelsFromConfig, type AgentModelsOptions, RoleResolutionError } from './AgentModels';
import type { ConfigRole, ProfileConfig, ProfileModeName, RoleBinding, FoldConfig } from './ConfigSchema';

type RoleBindingBuilder = {
    provider: string;
    model?: string;
    reasoning?: NonNullable<RoleBinding['reasoning']>;
};

type RolesBuilder = {
    smart: RoleBinding;
    fast: RoleBinding;
    orchestrator?: RoleBinding;
};

export type ConfiguredModelSelection = Data.TaggedEnum<{
    profile: { readonly profile: string };
    direct: {
        readonly provider: string;
        readonly model: string;
        readonly reasoning?: RoleBinding['reasoning'];
    };
}>;

export type ProfileModelSelection = Data.TaggedEnum.Value<ConfiguredModelSelection, 'profile'>;

export type DirectModelSelection = Data.TaggedEnum.Value<ConfiguredModelSelection, 'direct'>;

export const ConfiguredModelSelection = Data.taggedEnum<ConfiguredModelSelection>();

export type ModelConfiguration = {
    readonly profiles: ReadonlyArray<{ readonly name: string; readonly mode: ProfileConfig['mode'] | null }>;
    readonly providers: ReadonlyArray<{
        readonly name: string;
        readonly kind: FoldConfig['providers'][string]['kind'];
        readonly baseUrl?: string | null;
        readonly apiKeyEnv: string | null;
        readonly credentialPresent: boolean | null;
        readonly models: ReadonlyArray<string>;
    }>;
};

export type FoldModels = {
    readonly root: FoldModel<HttpClient.HttpClient | FileSystem.FileSystem | Path.Path>;
    readonly smart: FoldModel<HttpClient.HttpClient | FileSystem.FileSystem | Path.Path>;
    readonly fast: FoldModel<HttpClient.HttpClient | FileSystem.FileSystem | Path.Path>;
    readonly orchestrator: FoldModel<HttpClient.HttpClient | FileSystem.FileSystem | Path.Path>;
};

const roleBindings = (roles: FoldConfig['roles']): ReadonlyArray<RoleBinding> =>
    Arr.filter([roles.smart, roles.fast, roles.orchestrator], Predicate.isNotUndefined);

const bindings = (config: FoldConfig): ReadonlyArray<RoleBinding> => [
    ...roleBindings(config.roles),
    ...Arr.flatMap(Record.values(config.profiles ?? {}), roleBindings),
];

/** A secret-free view of selectable config. This is the shared CLI/TUI configuration boundary. */
export const describeModelConfiguration = (
    config: FoldConfig,
    catalog: ReadonlyArray<ModelCatalogEntry> = [],
    // oxlint-disable-next-line effecttsgo/process-env -- default env lookup; the TUI calls this synchronously outside Effect
    env: (name: string) => string | undefined = (name) => process.env[name],
): ModelConfiguration => ({
    profiles: [
        { name: 'default', mode: null },
        ...Arr.map(Record.toEntries(config.profiles ?? {}), ([name, profile]) => ({
            name,
            mode: profile.mode ?? null,
        })),
    ],
    providers: Arr.map(Record.toEntries(config.providers), ([name, provider]) => {
        const catalogProviderIds = Match.value(provider.kind).pipe(
            Match.when('anthropic', () => [name, 'anthropic']),
            Match.when('xai', () => [name, 'xai']),
            Match.when(Match.is('codex', 'opencode', 'openai-compat'), () => [name, 'openai']),
            Match.exhaustive,
        );

        const configured = Arr.flatMap(bindings(config), (binding) =>
            binding.provider === name && binding.model !== undefined ? [binding.model] : [],
        );

        const catalogModels = Arr.flatMap(catalog, (entry) =>
            catalogProviderIds.includes(entry.providerId) ? [entry.modelId] : [],
        );

        const defaultModels = Match.value(provider.kind).pipe(
            Match.when('codex', () => [DEFAULT_CODEX_MODEL_ID]),
            Match.when('opencode', () => [DEFAULT_OPENCODE_MODEL_ID, GROK_BUILD_MODEL_ID]),
            Match.when('xai', () => Arr.map(XAI_FRONTIER_MODELS, ({ modelId }) => modelId)),
            Match.orElse((): ReadonlyArray<string> => []),
        );

        const { configuredModels = [] } = provider;
        const models = [...new Set([...defaultModels, ...configuredModels, ...configured, ...catalogModels])].sort();

        return {
            name,
            kind: provider.kind,
            baseUrl: provider.baseUrl ?? null,
            apiKeyEnv: provider.apiKeyEnv ?? null,
            credentialPresent:
                provider.kind === 'codex' || provider.kind === 'opencode' || provider.kind === 'xai'
                    ? null
                    : provider.apiKeyEnv === undefined
                      ? provider.apiKey !== undefined && provider.apiKey.length > 0
                      : Boolean(env(provider.apiKeyEnv)),
            models,
        };
    }),
});

const rolesForProfile = (config: FoldConfig, name: string): FoldConfig['roles'] | null => {
    if (name === 'default') return config.roles;
    const profile = config.profiles?.[name];

    if (profile === undefined) return null;

    const roles: RolesBuilder = { smart: profile.smart, fast: profile.fast };

    if (profile.orchestrator !== undefined) roles.orchestrator = profile.orchestrator;

    return roles;
};

type DirectProviderSelection = {
    readonly provider: string;
    readonly model?: string;
    readonly reasoning?: RoleBinding['reasoning'];
};

const defaultModelsForProvider = (config: FoldConfig, selection: DirectProviderSelection) => {
    const kind = config.providers[selection.provider]?.kind;

    if (kind === 'codex') return { orchestrator: DEFAULT_CODEX_MODEL_ID, smart: 'gpt-5.6-terra', fast: 'gpt-5.6-luna' };

    if (kind === 'anthropic')
        return { orchestrator: DEFAULT_ANTHROPIC_MODEL_ID, smart: DEFAULT_ANTHROPIC_MODEL_ID, fast: 'claude-sonnet-5' };

    if (kind === 'opencode')
        return {
            orchestrator: DEFAULT_OPENCODE_MODEL_ID,
            smart: DEFAULT_OPENCODE_MODEL_ID,
            fast: DEFAULT_OPENCODE_MODEL_ID,
        };

    if (kind === 'xai')
        return { orchestrator: DEFAULT_XAI_MODEL_ID, smart: DEFAULT_XAI_MODEL_ID, fast: DEFAULT_XAI_MODEL_ID };

    return { orchestrator: selection.model, smart: selection.model, fast: selection.model };
};

/** A direct provider choice creates a provider-local role map; named profiles are the mixed-provider path. */
export const rolesForDirectProviderSelection = (
    config: FoldConfig,
    rootRole: ConfigRole,
    selection: DirectProviderSelection,
): FoldConfig['roles'] => {
    const models = defaultModelsForProvider(config, selection);

    const bindingFor = (role: ConfigRole): RoleBindingBuilder => {
        const model = models[role];
        const binding: RoleBindingBuilder = { provider: selection.provider };

        if (model !== undefined) binding.model = model;

        return binding;
    };

    const root = bindingFor(rootRole);

    if (selection.model !== undefined) root.model = selection.model;

    if (selection.reasoning !== undefined) root.reasoning = selection.reasoning;

    return {
        orchestrator: rootRole === 'orchestrator' ? root : bindingFor('orchestrator'),
        smart: rootRole === 'smart' ? root : bindingFor('smart'),
        fast: rootRole === 'fast' ? root : bindingFor('fast'),
    };
};

/** Resolve a discriminated UI choice without duplicating provider or credential logic in the caller. */
export const resolveConfiguredModelSelection = (
    config: FoldConfig,
    selection: ConfiguredModelSelection,
    mode: ProfileModeName = 'default',
    options: AgentModelsOptions | undefined,
): Effect.Effect<FoldModels, RoleResolutionError> => {
    const rootRole = roleForMode(mode);

    return Effect.gen(function* () {
        let roles = config.roles;

        if (Predicate.isTagged(selection, 'profile')) {
            const profileRoles = rolesForProfile(config, selection.profile);

            if (profileRoles === null) {
                return yield* RoleResolutionError.make({
                    role: rootRole,
                    message: `unknown model profile "${selection.profile}"`,
                });
            }

            roles = profileRoles;
        } else {
            roles = rolesForDirectProviderSelection(config, rootRole, selection);
        }

        const resolver = agentModelsFromConfig({ ...config, roles }, options);

        return yield* Effect.all({
            root: resolver.resolve(rootRole),
            smart: resolver.resolve('smart'),
            fast: resolver.resolve('fast'),
            orchestrator: resolver.resolve('orchestrator'),
        });
    });
};

export const roleForMode = (mode: ProfileModeName): ConfigRole => (mode === 'rlm' ? 'orchestrator' : 'smart');
