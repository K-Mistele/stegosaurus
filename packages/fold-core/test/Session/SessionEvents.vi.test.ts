import { expect, it } from '@effect/vitest';
import { Array as Arr, Effect, Fiber, Predicate, Stream, String as Str } from 'effect';

import { Session } from '../../src/index';
import { makeScriptedLanguageModel, textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel';
import { layerEventfulEchoTool, makeEchoRecorder } from '../TestLayers/TestTools';
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers';
import { sessionBaseLayer, startSessionInput } from './SessionTestHelpers';

const durableTags = [
    'session_started',
    'agent_started',
    'system-message',
    'user-message',
    'assistant-message',
    'tool-result',
    'assistant-message',
    'agent-finished',
];

it.effect('surfaces durable rows and one ephemeral tool-progress delta on Session.events', () =>
    Effect.gen(function* () {
        const recorder = yield* makeEchoRecorder;

        const scripted = yield* makeScriptedLanguageModel([
            toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: 'hi' } }], undefined),
            textTurn('Tool said hi', undefined),
        ]);

        const layer = sessionBaseLayer(scripted.layer, layerEventfulEchoTool(recorder));

        const result = yield* Effect.gen(function* () {
            const session = yield* Session;

            const started = yield* session.start(startSessionInput({}));

            // Establish the merged events subscription on a child fiber that starts immediately: the AgentEvents
            // PubSub subscription is live-only, so it must register before `send` publishes the tool delta.
            // `startImmediately` runs the collector synchronously until it forks the merge's subscribe fibers and
            // suspends; the single `yieldNow` then lets those fibers register their subscriptions before `send`
            // runs. Scheduling is cooperative and deterministic, so no wall-clock sleep is needed. Durable log
            // rows still replay from seq 0, so pre-subscription rows are not missed either.
            const collector = yield* session.events().pipe(
                Stream.takeUntil((event) => event.kind === 'log' && Predicate.isTagged(event.entry, 'agent-finished')),
                Stream.runCollect,
                Effect.forkChild({ startImmediately: true }),
            );

            yield* Effect.yieldNow;

            const finished = yield* session.send({ text: 'use the echo tool' });
            const collected = yield* Fiber.join(collector);
            const entries = yield* collectEntries;

            return { started, finished, collected, entries };
        }).pipe(Effect.provide(layer));

        expect(result.finished.outcome).toBe('completed');
        expect(result.finished.resultText).toBe('Tool said hi');

        // EventLog.subscribe replays from seq 0, so every durable row appears on the merged stream in order.
        const logTags = Arr.flatMap(result.collected, (event) => (event.kind === 'log' ? [event.entry._tag] : []));
        expect(logTags).toEqual(durableTags);

        // AgentRuntime now republishes streamed assistant text as ephemeral deltas too, so Session.events carries
        // the turn-2 text delta alongside the tool-progress delta. Isolate the tool-progress delta, which still
        // carries the tool's progress payload and runtime identity.
        const deltas = Arr.flatMap(result.collected, (event) => (event.kind === 'delta' ? [event] : []));
        const toolProgressDeltas = Arr.flatMap(deltas, (event) => (event.part.type === 'tool-progress' ? [event] : []));
        expect(toolProgressDeltas).toHaveLength(1);

        const delta = toolProgressDeltas[0];

        if (delta === undefined) throw new Error('expected exactly one tool-progress delta event');

        const part = delta.part;

        if (part.type !== 'tool-progress') throw new Error('expected a tool-progress delta part');
        expect(part.toolName).toBe('echo');
        expect(part.payload).toEqual({ progress: 'working:hi' });

        expect(delta.agentId).toBe(result.started.rootAgentId);

        const toolCallId = delta.toolCallId;

        if (toolCallId === null) throw new Error('expected a tool call id on the delta');
        expect(Str.startsWith('tool_call_')(toolCallId)).toBe(true);

        // The durable log never gained a row for the ephemeral delta: it is exactly the 8 durable tags.
        expect(Arr.map(result.entries, (entry) => entry._tag)).toEqual(durableTags);
    }),
);
