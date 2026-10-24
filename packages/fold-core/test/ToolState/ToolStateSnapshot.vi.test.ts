import { describe, expect, it } from '@effect/vitest';
import { Array as Arr, Effect, Layer, Predicate, type Schema, Stream } from 'effect';

import {
    AgentId,
    EventLog,
    layerInMemoryEventLog,
    LogEntryInputs,
    StateId,
    ToolCallId,
    toolStateServiceForHandler,
    type LogEntry,
} from '../../src/index';
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime';

const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa');

const toolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa');

const layer = Layer.mergeAll(layerInMemoryEventLog, layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 }));

const appendSharedValue = (value: Schema.Json) =>
    Effect.gen(function* () {
        const eventLog = yield* EventLog;

        yield* eventLog
            .append(
                LogEntryInputs['tool_state']({
                    agentId,
                    parentAgentId: null,
                    toolCallId: null,
                    namespace: 'probe',
                    stateId: StateId.create(),
                    key: 'shared',
                    value,
                }),
            )
            .pipe(Effect.orDie);
    });

const collectLogEntries = Effect.gen(function* () {
    const eventLog = yield* EventLog;

    return yield* Stream.runCollect(eventLog.entries()).pipe(
        Effect.orDie,
        Effect.map((entries): ReadonlyArray<LogEntry> => entries),
    );
});

describe('handler ToolState snapshot semantics', () => {
    it.effect('reads the snapshot, ignores later log appends, and sees its own writes', () =>
        Effect.gen(function* () {
            yield* appendSharedValue('seeded');

            const snapshot = yield* collectLogEntries;

            const state = yield* toolStateServiceForHandler({
                agentId,
                parentAgentId: null,
                toolCallId,
                snapshot,
            });

            const seeded = yield* state.get('probe', 'shared');

            // A sibling call writes after the fork point; the snapshot must not observe it.
            yield* appendSharedValue('external');
            const afterExternal = yield* state.get('probe', 'shared');

            // The call's own write is visible immediately and persisted durably.
            yield* state.set('probe', 'shared', 'mine');
            const afterOwnWrite = yield* state.get('probe', 'shared');

            // An own null write shadows the snapshot value.
            yield* state.set('probe', 'shared', null);
            const afterOwnClear = yield* state.get('probe', 'shared');

            const entries = yield* collectLogEntries;

            const stateValues = Arr.map(
                Arr.filter(entries, (entry) => Predicate.isTagged(entry, 'tool_state')),
                (entry) => entry.value,
            );

            expect(seeded).toBe('seeded');
            expect(afterExternal).toBe('seeded');
            expect(afterOwnWrite).toBe('mine');
            expect(afterOwnClear).toBeNull();
            expect(stateValues).toEqual(['seeded', 'external', 'mine', null]);
        }).pipe(Effect.provide(layer)),
    );
});
