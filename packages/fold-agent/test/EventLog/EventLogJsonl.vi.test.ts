import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { it, expect } from '@effect/vitest';
import {
    AgentId,
    AssistantMessageLogEntryInput,
    EventId,
    EventLog,
    EventLogCorruptEntryError,
    EventLogUnsupportedVersionError,
    MessageId,
    SessionId,
    SessionStartedLogEntryInput,
    StateId,
    ToolStateLogEntryInput,
    type LogEntryInput,
} from '@stegosaurus/fold-core';
import { Array as Arr, Effect, Fiber, FileSystem, Layer, Path, Predicate, Schema, Stream, String as Str } from 'effect';

import { layerJsonl } from '../../src/index';

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeSessionStarted = (cwd: string): LogEntryInput =>
    SessionStartedLogEntryInput.make({
        agentId: null,
        parentAgentId: null,
        toolCallId: null,
        cwd,
        sessionId: SessionId.create(),
        rootAgentId: AgentId.create(),
        meta: {},
    });

const makeToolState = (value: Schema.Json): LogEntryInput =>
    ToolStateLogEntryInput.make({
        agentId: AgentId.create(),
        parentAgentId: null,
        toolCallId: null,
        namespace: 'guard',
        stateId: StateId.create(),
        key: 'count',
        value,
    });

it.effect('jsonl layer writes one entry per line and reopens existing logs', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' });
            const filePath = path.join(dir, 'session.jsonl');

            const firstRead = yield* Effect.gen(function* () {
                const log = yield* EventLog;
                yield* log.append(makeSessionStarted('/tmp/one'));
                yield* log.append(makeSessionStarted('/tmp/two'));
                yield* log.append(makeToolState(41));

                return yield* Stream.runCollect(log.entries());
            }).pipe(Effect.provide(layerJsonl(filePath)));

            const contents = yield* fs.readFileString(filePath);
            const lines = Arr.filter(Str.split(contents, '\n'), (line) => line.length > 0);

            const reopenedRead = yield* Effect.gen(function* () {
                const log = yield* EventLog;

                return yield* Stream.runCollect(log.entries(1));
            }).pipe(Effect.provide(layerJsonl(filePath)));

            expect(Arr.map(firstRead, (entry) => entry.seq)).toEqual([0, 1, 2]);
            expect(Arr.every(firstRead, (entry) => EventId.is(entry.eventId))).toBe(true);
            expect(new Set(Arr.map(firstRead, (entry) => entry.eventId)).size).toBe(3);
            expect(lines).toHaveLength(3);
            const firstLine = yield* decodeJson(lines[0] ?? '{}');
            const secondLine = yield* decodeJson(lines[1] ?? '{}');
            const thirdLine = yield* decodeJson(lines[2] ?? '{}');
            expect(firstLine).toHaveProperty('_tag', 'session_started');
            expect(firstLine).toMatchObject({
                seq: 0,
                eventId: firstRead[0]?.eventId,
            });
            expect(secondLine).toHaveProperty('_tag', 'session_started');
            expect(secondLine).toMatchObject({
                seq: 1,
                eventId: firstRead[1]?.eventId,
            });
            expect(thirdLine).toHaveProperty('_tag', 'tool_state');
            expect(thirdLine).toMatchObject({
                seq: 2,
                eventId: firstRead[2]?.eventId,
                namespace: 'guard',
                key: 'count',
                value: 41,
                toolCallId: null,
            });
            expect(Arr.map(reopenedRead, (entry) => entry.seq)).toEqual([1, 2]);
            expect(Arr.map(reopenedRead, (entry) => entry.eventId)).toEqual(
                Arr.map(firstRead.slice(1), (entry) => entry.eventId),
            );
        }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect('jsonl layer maps invalid persisted lines to EventLogCorruptEntryError', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' });
            const filePath = path.join(dir, 'corrupt.jsonl');

            yield* fs.writeFileString(filePath, '{not json}\n');

            const error = yield* Effect.gen(function* () {
                const log = yield* EventLog;

                return yield* Stream.runCollect(log.entries());
            }).pipe(Effect.provide(layerJsonl(filePath)), Effect.flip);

            if (!Predicate.isTagged(error, 'EventLogCorruptEntryError')) {
                throw new Error(`expected EventLogCorruptEntryError, got ${error._tag}`);
            }

            expect(error.line).toBe(1);
        }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect('jsonl layer requires valid persisted CUID event IDs', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' });
            const filePath = path.join(dir, 'missing-event-id.jsonl');

            yield* fs.writeFileString(
                filePath,
                `${yield* encodeJson({ ...makeSessionStarted('/tmp/missing-event-id'), seq: 0, ts: 1 })}\n`,
            );

            const error = yield* Effect.gen(function* () {
                const log = yield* EventLog;

                return yield* Stream.runCollect(log.entries());
            }).pipe(Effect.provide(layerJsonl(filePath)), Effect.flip);

            expect(error).toBeInstanceOf(EventLogCorruptEntryError);
        }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect('jsonl layer replays assistant usage when cache fields are absent', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' });
            const filePath = path.join(dir, 'usage.jsonl');
            const agentId = AgentId.create();

            const line = yield* encodeJson({
                ...AssistantMessageLogEntryInput.make({
                    agentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: MessageId.create(),
                    message: { options: {}, role: 'assistant', content: 'done' },
                    finish: {
                        reason: 'stop',
                        usage: {
                            inputTokens: { uncached: 10, total: 10, cacheRead: 0 },
                            outputTokens: { total: 2 },
                        },
                    },
                }),
                seq: 0,
                eventId: EventId.create(),
                ts: 1,
            });

            yield* fs.writeFileString(filePath, `${line}\n`);

            const entries = yield* Effect.gen(function* () {
                const log = yield* EventLog;

                return yield* Stream.runCollect(log.entries());
            }).pipe(Effect.provide(layerJsonl(filePath)));

            const entry = entries[0];

            expect(entry?._tag).toBe('assistant-message');

            if (!Predicate.isTagged(entry, 'assistant-message')) return;
            expect(entry.finish?.usage.inputTokens?.cacheWrite).toBeUndefined();
            expect(entry.finish?.usage.inputTokens?.cacheRead).toBe(0);
            expect(entry.finish?.usage.outputTokens?.total).toBe(2);
            expect(entry.version).toBe(1);
        }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect('jsonl layer rejects event formats newer than the installed Fold runtime', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' });
            const filePath = path.join(dir, 'future-version.jsonl');

            const line = yield* encodeJson({
                ...makeSessionStarted('/tmp/future-version'),
                seq: 0,
                eventId: EventId.create(),
                ts: 1,
                version: 2,
            });

            yield* fs.writeFileString(filePath, `${line}\n`);

            const error = yield* Effect.gen(function* () {
                const log = yield* EventLog;

                return yield* Stream.runCollect(log.entries());
            }).pipe(Effect.provide(layerJsonl(filePath)), Effect.flip);

            expect(error).toBeInstanceOf(EventLogUnsupportedVersionError);

            if (Predicate.isTagged(error, 'EventLogUnsupportedVersionError')) {
                expect(error.version).toBe(2);
                expect(error.supportedVersions).toEqual([1]);
            }
        }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect('jsonl subscribe replays and follows live appends', () =>
    Effect.scoped(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'fold-event-log-' });
            const filePath = path.join(dir, 'subscribe.jsonl');

            const result = yield* Effect.gen(function* () {
                const log = yield* EventLog;
                yield* log.append(makeSessionStarted('/tmp/one'));

                const fiber = yield* Stream.runCollect(log.subscribe(0).pipe(Stream.take(2))).pipe(Effect.forkChild);
                yield* log.append(makeSessionStarted('/tmp/two'));

                return yield* Fiber.join(fiber);
            }).pipe(Effect.provide(layerJsonl(filePath)));

            expect(Arr.map(result, (entry) => entry.seq)).toEqual([0, 1]);
        }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);
