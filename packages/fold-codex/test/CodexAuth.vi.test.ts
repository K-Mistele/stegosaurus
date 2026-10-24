import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Option, Path, Predicate, type Schema } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/http';

import {
    CodexAuth,
    CodexAuthStore,
    CodexTokenData,
    extractAccountIdFromToken,
    layerCodexAuth,
    layerCodexAuthStore,
    parseJwtClaims,
} from '../src/index';

const tempStorePath = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix: 'fold-codex-auth-' });

    return path.join(directory, 'auth.json');
});

const jwtWith = (claimsJson: string): string =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(claimsJson).toString('base64url')}.sig`;

type RecordedRequest = { readonly url: string; readonly body: string };

const isWebRequest = (input: string | URL | Request): input is Request => Predicate.hasProperty(input, 'url');

/** A FetchHttpClient layer whose network is a scripted function, recording every request it serves. */
const scriptedFetchLayer = (respond: (request: RecordedRequest) => Response) => {
    const requests: Array<RecordedRequest> = [];

    const fakeFetch: typeof fetch = (input: string | URL | Request, init: RequestInit | undefined) => {
        const request = isWebRequest(input) ? input : new Request(String(input), init);

        return request
            .clone()
            .text()
            .then((body) => {
                const recorded = { url: request.url, body };
                requests.push(recorded);

                return respond(recorded);
            });
    };

    const layer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
    );

    return { layer, requests };
};

const jsonResponse = (body: Schema.Json, status = 200): Response =>
    Response.json(body, { status, headers: { 'content-type': 'application/json' } });

/** A temp auth document, holding `token` under the `codex` entry when one is given. */
const seededStorePath = (token: CodexTokenData | undefined): Effect.Effect<string> =>
    Effect.gen(function* () {
        const path = yield* Effect.orDie(tempStorePath);

        if (token !== undefined) {
            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;
                yield* Effect.orDie(store.save(token));
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }

        return path;
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

/** CodexAuth and its credential store over the document at `path`, talking to the scripted `network`. */
const authLayer = (path: string, network: Layer.Layer<HttpClient.HttpClient>) => {
    const store = layerCodexAuthStore({ path }).pipe(
        Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    );

    return Layer.merge(layerCodexAuth(undefined).pipe(Layer.provide([store, network])), store);
};

describe('JWT account id extraction', () => {
    it('reads the direct claim first', () => {
        const token = jwtWith('{"chatgpt_account_id":"acct_direct"}');
        expect(Option.getOrNull(extractAccountIdFromToken(token))).toBe('acct_direct');
    });

    it('falls back to the namespaced claim, then the first organization', () => {
        const namespaced = jwtWith('{"https://api.openai.com/auth":{"chatgpt_account_id":"acct_nested"}}');
        expect(Option.getOrNull(extractAccountIdFromToken(namespaced))).toBe('acct_nested');

        const organization = jwtWith('{"organizations":[{"id":"org_1"},{"id":"org_2"}]}');
        expect(Option.getOrNull(extractAccountIdFromToken(organization))).toBe('org_1');
    });

    it('malformed tokens parse to none, never failures', () => {
        expect(Option.isNone(parseJwtClaims('not-a-jwt'))).toBe(true);
        expect(Option.isNone(parseJwtClaims('a.b'))).toBe(true);
        expect(Option.isNone(parseJwtClaims(`x.${Buffer.from('[1,2]').toString('base64url')}.y`))).toBe(true);
    });
});

describe('CodexAuth.get', () => {
    // Under it.effect the TestClock starts at epoch 0, so expiry arithmetic is deterministic:
    // a token expiring at 100s is valid (buffer 30s), one expiring at 10s is already expired.
    const validToken = CodexTokenData.make({
        type: 'oauth',
        access: 'valid-access',
        refresh: 'valid-refresh',
        expires: 100_000,
        accountId: 'acct_cached',
    });

    const expiredToken = CodexTokenData.make({
        type: 'oauth',
        access: 'stale-access',
        refresh: 'stale-refresh',
        expires: 10_000,
        accountId: 'acct_old',
    });

    it.effect('returns the cached token without touching the network', () =>
        Effect.gen(function* () {
            const network = scriptedFetchLayer(() => {
                throw new Error('no network call expected');
            });

            const path = yield* seededStorePath(validToken);
            yield* Effect.gen(function* () {
                const auth = yield* CodexAuth;

                const token = yield* auth.get;
                expect(token.access).toBe('valid-access');
                expect(network.requests).toHaveLength(0);
            }).pipe(Effect.provide(authLayer(path, network.layer)));
        }),
    );

    it.effect('fails NotAuthenticated when the store is empty', () =>
        Effect.gen(function* () {
            const network = scriptedFetchLayer(() => {
                throw new Error('no network call expected');
            });

            const path = yield* seededStorePath(undefined);
            yield* Effect.gen(function* () {
                const auth = yield* CodexAuth;
                const store = yield* CodexAuthStore;

                const result = yield* auth.get.pipe(Effect.flip);
                expect(result._tag).toBe('CodexAuthError');
                expect(result.reason).toBe('NotAuthenticated');
                expect(result.message).toContain(store.path);
            }).pipe(Effect.provide(authLayer(path, network.layer)));
        }),
    );

    it.effect('refreshes an expired token, persists it, and preserves the account id', () =>
        Effect.gen(function* () {
            const network = scriptedFetchLayer((request) => {
                expect(request.url).toBe('https://auth.openai.com/oauth/token');
                const params = new URLSearchParams(request.body);
                expect(params.get('grant_type')).toBe('refresh_token');
                expect(params.get('refresh_token')).toBe('stale-refresh');
                expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');

                // No id_token and a non-JWT access token: the previous accountId must be preserved.
                return jsonResponse({
                    access_token: 'fresh-access',
                    refresh_token: 'fresh-refresh',
                    expires_in: 3600,
                });
            });

            const path = yield* seededStorePath(expiredToken);
            yield* Effect.gen(function* () {
                const auth = yield* CodexAuth;
                const store = yield* CodexAuthStore;

                const token = yield* auth.get;
                expect(token.access).toBe('fresh-access');
                expect(token.refresh).toBe('fresh-refresh');
                expect(token.expires).toBe(3_600_000);
                expect(token.accountId).toBe('acct_old');

                const persisted = yield* store.load;
                expect(Option.isSome(persisted)).toBe(true);

                if (Option.isSome(persisted)) expect(persisted.value.access).toBe('fresh-access');
            }).pipe(Effect.provide(authLayer(path, network.layer)));
        }),
    );

    it.effect('extracts the account id from a refreshed id_token', () =>
        Effect.gen(function* () {
            const network = scriptedFetchLayer(() =>
                jsonResponse({
                    access_token: 'fresh-access',
                    refresh_token: 'fresh-refresh',
                    expires_in: 60,
                    id_token: jwtWith('{"chatgpt_account_id":"acct_new"}'),
                }),
            );

            const path = yield* seededStorePath(expiredToken);
            yield* Effect.gen(function* () {
                const auth = yield* CodexAuth;

                const token = yield* auth.get;
                expect(token.accountId).toBe('acct_new');
            }).pipe(Effect.provide(authLayer(path, network.layer)));
        }),
    );

    it.effect('single-flights concurrent refreshes', () =>
        Effect.gen(function* () {
            const network = scriptedFetchLayer(() =>
                jsonResponse({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
            );

            const path = yield* seededStorePath(expiredToken);
            yield* Effect.gen(function* () {
                const auth = yield* CodexAuth;

                const [first, second] = yield* Effect.all([auth.get, auth.get], { concurrency: 2 });
                expect(first.access).toBe('fresh-access');
                expect(second.access).toBe('fresh-access');
                expect(network.requests).toHaveLength(1);
            }).pipe(Effect.provide(authLayer(path, network.layer)));
        }),
    );

    it.effect('a failed refresh surfaces RefreshFailed and keeps the stored credential', () =>
        Effect.gen(function* () {
            // 400 is not transient, so the issuer client does not retry and the failure is immediate.
            const network = scriptedFetchLayer(() => jsonResponse({ error: 'invalid_grant' }, 400));
            const path = yield* seededStorePath(expiredToken);
            yield* Effect.gen(function* () {
                const auth = yield* CodexAuth;
                const store = yield* CodexAuthStore;

                const result = yield* auth.get.pipe(Effect.flip);
                expect(result.reason).toBe('RefreshFailed');

                const persisted = yield* store.load;
                expect(Option.isSome(persisted)).toBe(true);

                if (Option.isSome(persisted)) expect(persisted.value.refresh).toBe('stale-refresh');
            }).pipe(Effect.provide(authLayer(path, network.layer)));
        }),
    );

    it.effect('logout clears the stored credential', () =>
        Effect.gen(function* () {
            const network = scriptedFetchLayer(() => {
                throw new Error('no network call expected');
            });

            const path = yield* seededStorePath(validToken);
            yield* Effect.gen(function* () {
                const auth = yield* CodexAuth;
                const store = yield* CodexAuthStore;

                yield* auth.logout;
                const persisted = yield* store.load;
                expect(Option.isNone(persisted)).toBe(true);

                const result = yield* auth.get.pipe(Effect.flip);
                expect(result.reason).toBe('NotAuthenticated');
            }).pipe(Effect.provide(authLayer(path, network.layer)));
        }),
    );
});
