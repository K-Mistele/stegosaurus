/**
 * A Codex model reads the credential saved under its own provider name in its own auth document - the
 * same entry `foldcode auth codex login --provider <name> --fold-home <dir>` writes.
 */
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Path, Predicate } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { CodexAuthStore, CodexTokenData, layerCodexAuthStore, makeCodexLanguageModel } from '../src/index';

const terminalSse =
    'data: {"type":"response.completed","response":{"id":"resp_credentials","model":"gpt-5.5","created_at":1,"output":[]},"sequence_number":1}\n\n';

const isWebRequest = (input: string | URL | Request): input is Request => Predicate.hasProperty(input, 'url');

it.effect('uses the credential saved under its provider name in its auth document', () => {
    const authorizations: Array<string | null> = [];

    const capturingFetch: typeof fetch = (input: string | URL | Request, init: RequestInit | undefined) => {
        const request = isWebRequest(input) ? input : new Request(String(input), init);
        authorizations.push(request.headers.get('authorization'));

        return Promise.resolve(
            new Response(terminalSse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
    };

    return Effect.gen(function* () {
        // Only a `work` entry exists: the default `codex` entry is absent.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const authStorePath = path.join(
            yield* fs.makeTempDirectory({ prefix: 'fold-codex-credentials-' }),
            'auth.json',
        );

        yield* Effect.gen(function* () {
            const store = yield* CodexAuthStore;
            yield* store.save(
                CodexTokenData.make({
                    type: 'oauth',
                    access: 'work-access',
                    refresh: 'work-refresh',
                    expires: Number.MAX_SAFE_INTEGER,
                }),
            );
        }).pipe(Effect.provide(layerCodexAuthStore({ path: authStorePath, providerId: 'work' })));

        const model = yield* makeCodexLanguageModel({
            providerId: 'work',
            authStorePath,
            model: 'gpt-5.5',
            apiUrl: 'https://codex.credentials.test/backend-api/codex',
            requestRetryTimes: 0,
        });

        yield* model.generateText({ prompt: 'hi' });

        expect(authorizations).toEqual(['Bearer work-access']);
    }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeFileSystem.layer, NodePath.layer)),
        Effect.provideService(FetchHttpClient.Fetch, capturingFetch),
    );
});
