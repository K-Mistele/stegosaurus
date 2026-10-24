import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';

import { layerOpenCodeAuthStore, OpenCodeAuthDocument, OpenCodeAuthStore, OpenCodeTokenData } from '../src/AuthStore';

const tempStorePath = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix: 'fold-opencode-store-' });

    return path.join(directory, 'auth.json');
});

const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeAuthDocument));

const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(OpenCodeAuthDocument));

const readDocument = (path: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        return yield* decodeDocument(yield* fs.readFileString(path));
    });

const readText = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));

const writeText = (path: string, text: string) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text));

const platformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const token = OpenCodeTokenData.make({
    type: 'oauth',
    access: 'access',
    refresh: 'refresh',
    expires: 42,
    metadata: { server: 'https://opencode.ai', accountID: 'acc', email: 'a@b.c' },
});

describe('OpenCodeAuthStore', () => {
    it.effect('round-trips a token and preserves other providers entries', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* writeText(path, yield* encodeDocument({ codex: { type: 'oauth', nested: [1, null] } }));
            yield* Effect.gen(function* () {
                const store = yield* OpenCodeAuthStore;

                yield* store.save(token);
                const loaded = yield* store.load;
                expect(Option.getOrUndefined(loaded)?.metadata?.accountID).toBe('acc');

                const document = yield* readDocument(path);
                expect(document['codex']).toEqual({ type: 'oauth', nested: [1, null] });
                expect(document['opencode']).toEqual({
                    type: 'oauth',
                    access: 'access',
                    refresh: 'refresh',
                    expires: 42,
                    metadata: { server: 'https://opencode.ai', accountID: 'acc', email: 'a@b.c' },
                });

                yield* store.clear;
                expect((yield* readDocument(path))['opencode']).toBeUndefined();
            }).pipe(Effect.provide(layerOpenCodeAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );

    it.effect('loads nothing from a corrupt document and refuses to overwrite it', () =>
        Effect.gen(function* () {
            const path = yield* tempStorePath;
            yield* writeText(path, '{ not json');
            yield* Effect.gen(function* () {
                const store = yield* OpenCodeAuthStore;

                expect(Option.isNone(yield* store.load)).toBe(true);
                const error = yield* Effect.flip(store.save(token));
                expect(error.reason).toBe('InvalidDocument');
                expect(yield* readText(path)).toBe('{ not json');
            }).pipe(Effect.provide(layerOpenCodeAuthStore({ path })));
        }).pipe(Effect.provide(platformLayer)),
    );
});
