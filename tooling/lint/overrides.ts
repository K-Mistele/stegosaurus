import type { OxlintOverride } from 'vite-plus/lint';

export const overrides = [
    {
        files: ['**/*.test.ts'],
        plugins: ['vitest'],
        rules: {
            'vitest/no-standalone-expect': 'off',
            // Vitest accepts a failure message as `expect`'s second argument.
            'vitest/valid-expect': ['error', { maxArgs: 2 }],
        },
    },
    {
        // Each test is its own entry point: providing a fresh layer per test is how tests get isolated state.
        files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**', '**/tests/**'],
        rules: {
            'effecttsgo/strict-effect-provide': 'off',
            // Test fakes check whether a service was provided; real code requires its services.
            'automation/no-service-option': 'off',
        },
    },
    {
        // Package entry points: re-exporting the public API is their job.
        files: [
            'packages/fold-agent/src/index.ts',
            'packages/fold-codex/src/index.ts',
            'packages/fold-core/src/index.ts',
            'packages/fold-opencode/src/index.ts',
            'packages/fold-xai/src/index.ts',
            'packages/channels-alchemy-cloudflare/src/index.ts',
            'packages/channels-github/src/index.ts',
            'packages/channels-linear/src/index.ts',
            'packages/channels-redis/src/index.ts',
            'packages/channels-slack/src/index.ts',
            'packages/channels-sql/src/index.ts',
        ],
        rules: {
            'automation/no-reexport-only-modules': 'off',
        },
    },
    {
        // The OAuth browser flows run a local callback server on node:http; moving to Effect's HttpServer is a redesign.
        files: ['packages/fold-codex/src/OAuthFlows.ts', 'packages/fold-xai/src/OAuthFlows.ts'],
        rules: {
            'effecttsgo/node-builtin-import': 'off',
            'effecttsgo/new-promise': 'off',
        },
    },
    {
        // Plain synchronous path helpers (e.g. `sessionsDirFor`, `defaultFoldHome`) that callers use outside Effect.
        // Their Effect code uses `Path.Path`; these files still import `node:path` for the helpers.
        files: [
            'packages/fold-agent/src/Bin/ManagedBinaries.ts',
            'packages/fold-agent/src/Catalog/LoadCatalog.ts',
            'packages/fold-agent/src/Config/ConfigSchemaJson.ts',
            'packages/fold-agent/src/Config/FoldInfo.ts',
            'packages/fold-agent/src/Config/Load.ts',
            'packages/fold-agent/src/OutputStore/OutputStore.ts',
            'packages/fold-agent/src/Session/SessionLayout.ts',
            'packages/fold-codex/src/AuthStore.ts',
            'packages/fold-opencode/src/AuthStore.ts',
            'packages/fold-xai/src/AuthStore.ts',
            // A synchronous in-memory FileSystem fixture, and a real node:http loopback server.
            'packages/fold-agent/test/TestHelpers.ts',
            'packages/fold-agent/test/Tools/WebFetchTool.vi.test.ts',
        ],
        rules: {
            'effecttsgo/node-builtin-import': 'off',
        },
    },
    {
        // CodexAuth and XaiAuth provide NodeCrypto to those flows; TitleGenerator builds a model layer per request.
        files: [
            'packages/fold-codex/src/CodexAuth.ts',
            'packages/fold-xai/src/XaiAuth.ts',
            'packages/fold-agent/src/Session/TitleGenerator.ts',
        ],
        rules: {
            'effecttsgo/strict-effect-provide': 'off',
        },
    },
    {
        // RS256 signing for GitHub App JWTs: Effect's Crypto has no RSA signing, and this service is the Web Crypto seam tests replace.
        files: ['packages/channels-github/src/api/GitHubAppSigner.ts'],
        rules: {
            'automation/no-ambient-nondeterminism': 'off',
        },
    },
    {
        // Test webhooks are signed with node:crypto HMAC, independent of the packages' own HMAC under test.
        files: ['packages/channels-github/test/fixtures.ts', 'packages/channels-linear/test/fixtures.ts'],
        rules: {
            'effecttsgo/node-builtin-import': 'off',
        },
    },
    {
        // Effect types `HttpRouter.asHttpEffect()` with an `unknown` error; the router renders its own error responses.
        files: ['packages/channels-delivery/src/Channels.ts'],
        rules: {
            'effecttsgo/any-unknown-in-error-context': 'off',
        },
    },
] satisfies OxlintOverride[];
