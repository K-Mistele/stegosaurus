import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';

import {
    CodexAuthDocument,
    CodexAuthStore,
    CodexTokenData,
    layerCodexAuthStore,
    TOKEN_EXPIRY_BUFFER_MS,
} from '../src/index';

const platformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const tempStorePath = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix: 'fold-codex-store-' });

    return path.join(directory, 'auth.json');
});

const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexAuthDocument));

const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(CodexAuthDocument));

const readDocument = (path: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        return yield* decodeDocument(yield* fs.readFileString(path));
    });

const writeDocument = (path: string, document: CodexAuthDocument) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        yield* fs.writeFileString(path, yield* encodeDocument(document));
    });

const writeText = (path: string, text: string) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text));

const readText = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));

const sampleToken = CodexTokenData.make({
    type: 'oauth',
    access: 'access-token-1',
    refresh: 'refresh-token-1',
    expires: 1_000_000,
    accountId: 'acct_123',
});

describe('CodexAuthStore', () => {
    it.effect('load returns none for a missing store', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;
                const loaded = yield* store.load;
                expect(Option.isNone(loaded)).toBe(true);
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it.effect('save/load round-trips and forces 0600 permissions', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;

                yield* store.save(sampleToken);
                const loaded = yield* store.load;

                expect(Option.isSome(loaded)).toBe(true);

                if (Option.isSome(loaded)) {
                    expect(loaded.value.access).toBe('access-token-1');
                    expect(loaded.value.refresh).toBe('refresh-token-1');
                    expect(loaded.value.expires).toBe(1_000_000);
                    expect(loaded.value.accountId).toBe('acct_123');
                }

                const fs = yield* FileSystem.FileSystem;
                const info = yield* fs.stat(path);
                expect(info.mode & 0o777).toBe(0o600);
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it.effect('save preserves other providers entries in the document', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* writeDocument(path, { anthropic: { type: 'api', key: 'sk-other' } });

            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;
                yield* store.save(sampleToken);

                const document = yield* readDocument(path);
                expect(document['anthropic']).toEqual({ type: 'api', key: 'sk-other' });
                expect(document['codex']).toMatchObject({ access: 'access-token-1' });
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it.effect('clear removes only the codex entry', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* writeDocument(path, { anthropic: { type: 'api', key: 'sk-other' } });

            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;
                yield* store.save(sampleToken);
                yield* store.clear;

                const document = yield* readDocument(path);
                expect(document['codex']).toBeUndefined();
                expect(document['anthropic']).toEqual({ type: 'api', key: 'sk-other' });

                const loaded = yield* store.load;
                expect(Option.isNone(loaded)).toBe(true);
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it.effect('corrupt JSON degrades to no credentials without clobbering the file', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* writeText(path, 'not json at all {');

            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;
                const loaded = yield* store.load;

                expect(Option.isNone(loaded)).toBe(true);
                expect(yield* readText(path)).toBe('not json at all {');
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it.effect('save and clear refuse to overwrite a corrupt document', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* writeText(path, 'not json at all {');

            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;
                const saveError = yield* Effect.flip(store.save(sampleToken));
                const clearError = yield* Effect.flip(store.clear);

                expect(saveError.reason).toBe('InvalidDocument');
                expect(clearError.reason).toBe('InvalidDocument');
                expect(yield* readText(path)).toBe('not json at all {');
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it.effect('a token without an account id encodes without the key', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;
                yield* store.save(CodexTokenData.make({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }));

                expect((yield* readDocument(path))['codex']).toEqual({
                    type: 'oauth',
                    access: 'a',
                    refresh: 'r',
                    expires: 1,
                });
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it.effect('an invalid codex entry is skipped, not decoded', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* writeDocument(path, { codex: { type: 'api', key: 'wrong-shape' } });

            yield* Effect.gen(function* () {
                const store = yield* CodexAuthStore;
                const loaded = yield* store.load;
                expect(Option.isNone(loaded)).toBe(true);
            }).pipe(Effect.provide(layerCodexAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it('isExpired applies the 30s safety buffer', () => {
        const token = CodexTokenData.make({ type: 'oauth', access: 'a', refresh: 'r', expires: 100_000 });
        expect(token.isExpired(100_000 - TOKEN_EXPIRY_BUFFER_MS - 1)).toBe(false);
        expect(token.isExpired(100_000 - TOKEN_EXPIRY_BUFFER_MS)).toBe(false);
        expect(token.isExpired(100_000 - TOKEN_EXPIRY_BUFFER_MS + 1)).toBe(true);
        expect(token.isExpired(100_000)).toBe(true);
    });
});
