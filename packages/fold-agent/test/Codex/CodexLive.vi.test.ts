/**
 * Live integration against the real ChatGPT Codex backend using the credentials in ~/.fold/auth.json.
 * Opt-in: runs only with FOLD_CODEX_LIVE=1, outside CI, and with a codex credential, so `pnpm test` stays green.
 * These tests exercise the full stack: auth store -> token refresh (when expired) -> authed OpenAI
 * client -> instructions transform -> hardened stream.
 */
import { homedir } from 'node:os';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { makeCodexLanguageModel } from '@stegosaurus/fold-codex';
import { Array as Arr, Config, Effect, FileSystem, Layer, Option, Path, Schema, Stream, String as Str } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { expectedImageIdentification, runImageReadInference } from './SessionModelPathTestHarness';

/** What a Codex model needs from its host: an HTTP client and a filesystem for its credential store. */
const codexHostServices = Layer.mergeAll(FetchHttpClient.layer, NodeFileSystem.layer, NodePath.layer);

const decodeCredentialProbe = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ codex: Schema.optionalKey(Schema.Struct({ type: Schema.String })) })),
);

const hasCodexCredentials: Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const authPath = path.join(homedir(), '.fold', 'auth.json');

    if (!(yield* fs.exists(authPath))) return false;
    const document = decodeCredentialProbe(yield* fs.readFileString(authPath));

    return Option.isSome(document) && document.value.codex?.type === 'oauth';
}).pipe(Effect.orElseSucceed(() => false));

const liveSettings = await Effect.runPromise(
    Effect.gen(function* () {
        const ci = yield* Config.String('CI').pipe(Config.option);
        const live = yield* Config.String('FOLD_CODEX_LIVE').pipe(Config.option);
        const skip = !Option.contains(live, '1') || Option.exists(ci, Str.isNonEmpty) || !(yield* hasCodexCredentials);
        const modelId = yield* Config.String('FOLD_CODEX_LIVE_MODEL').pipe(Config.withDefault('gpt-5.5'));
        const imageRead = yield* Config.String('FOLD_CODEX_LIVE_IMAGE_READ').pipe(Config.option);

        return { skip, modelId, skipImageRead: skip || !Option.contains(imageRead, '1') };
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

const { skip, modelId, skipImageRead } = liveSettings;

describe.skipIf(skip)(
    'codex live (set FOLD_CODEX_LIVE=1; skipped in CI or without a codex entry in ~/.fold/auth.json)',
    () => {
        it.live(
            'generateText round-trips against the codex backend',
            () =>
                Effect.gen(function* () {
                    const service = yield* makeCodexLanguageModel({ model: modelId, reasoning: 'low' });

                    const response = yield* service.generateText({
                        prompt: [
                            { role: 'system', content: 'Answer with a single lowercase word and nothing else.' },
                            { role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word: pong' }] },
                        ],
                    });

                    expect(Str.toLowerCase(response.text)).toContain('pong');
                    expect(response.finishReason).toBe('stop');
                }).pipe(Effect.scoped, Effect.provide(codexHostServices)),
            180_000,
        );

        it.live(
            'streamText streams text deltas and a finish part',
            () =>
                Effect.gen(function* () {
                    const service = yield* makeCodexLanguageModel({ model: modelId, reasoning: 'low' });

                    const parts = yield* Stream.runCollect(
                        service.streamText({
                            prompt: [
                                { role: 'system', content: 'Answer with a single lowercase word and nothing else.' },
                                {
                                    role: 'user',
                                    content: [{ type: 'text', text: 'Reply with exactly the word: ping' }],
                                },
                            ],
                        }),
                    );

                    let text = '';

                    for (const part of parts) {
                        if (part.type === 'text-delta') text += part.delta;
                    }

                    expect(Str.toLowerCase(text)).toContain('ping');
                    expect(Arr.some(parts, (part) => part.type === 'finish')).toBe(true);
                }).pipe(Effect.scoped, Effect.provide(codexHostServices)),
            180_000,
        );
    },
);

// Opt-in regression probe proving a real Codex model can perceive an image returned by the read tool.
describe.skipIf(skipImageRead)(
    'codex image-read live (set FOLD_CODEX_LIVE_IMAGE_READ=1; skipped in CI or without local credentials)',
    () => {
        it.live(
            'identifies generated visual content delivered from the actual read result with zero inference tools',
            () =>
                Effect.gen(function* () {
                    const service = yield* makeCodexLanguageModel({ model: modelId, reasoning: 'low' });
                    const result = yield* runImageReadInference(service);
                    const normalized = Str.trim(Str.replaceAll(' ', '')(Str.toLowerCase(result.text)));

                    expect(normalized).toContain(expectedImageIdentification);
                }).pipe(Effect.scoped, Effect.provide(codexHostServices)),
            180_000,
        );
    },
);
