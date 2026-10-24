import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, it } from '@effect/vitest';
import { customModel, defineAgent, OpenAiReasoningDisabled, Session } from '@stegosaurus/fold-core';
import { Array as Arr, Cause, Effect, Exit, FileSystem, Layer, Path, Predicate, Stream } from 'effect';
import { LanguageModel } from 'effect/ai';

import { layerJsonl } from '../../src/index';

const agent = defineAgent({
    model: customModel({
        activeModel: {
            providerId: 'test',
            providerKind: 'openai-compatible',
            modelId: 'test',
            role: null,
            requestedReasoningLevel: 'off',
            reasoning: OpenAiReasoningDisabled.make({}),
        },
        make: LanguageModel.make({
            generateText: () => Effect.die('this test must not call a model'),
            streamText: () => Stream.empty,
        }),
    }),
});

it.effect('Session.open reopens a JSONL backend without duplicating identity or initialization rows', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-session-open-' });
        const path = pathService.join(dir, 'session.jsonl');

        const first = yield* Effect.gen(function* () {
            const session = yield* Session.open({ agent, cwd: '/original' });
            yield* session.setTitle('persisted');

            return { sessionId: session.sessionId, rootAgentId: session.rootAgentId, entries: yield* session.entries };
        }).pipe(Effect.provide(layerJsonl(path).pipe(Layer.orDie)), Effect.scoped);

        yield* Effect.gen(function* () {
            const session = yield* Session.open({ agent, sessionId: first.sessionId, cwd: '/ignored' });
            expect(session.sessionId).toBe(first.sessionId);
            expect(session.rootAgentId).toBe(first.rootAgentId);
            expect(yield* session.entries).toEqual(first.entries);
            yield* session.setTitle('after reopening');
            const entries = yield* session.entries;
            expect(Arr.filter(entries, Predicate.isTagged('session_started'))).toHaveLength(1);
            expect(Arr.map(entries, (entry) => entry.seq)).toEqual(Arr.map(entries, (_, index) => index));
            const last = entries.at(-1);
            expect(Predicate.isTagged(last, 'session_title')).toBe(true);
            expect(last).toMatchObject({ title: 'after reopening' });
        }).pipe(Effect.provide(layerJsonl(path).pipe(Layer.orDie)), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect('a corrupt JSONL acquisition remains a defect and is not replaced by an empty memory log', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-session-corrupt-' });
        const path = pathService.join(dir, 'session.jsonl');
        yield* fs.writeFileString(path, 'not JSON\n');

        const exit = yield* Session.open({ agent }).pipe(
            Effect.provide(layerJsonl(path).pipe(Layer.orDie)),
            Effect.exit,
        );

        if (!Exit.isFailure(exit)) throw new Error('expected corrupt log acquisition to fail');
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(false);
        expect(yield* fs.readFileString(path)).toBe('not JSON\n');
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);
