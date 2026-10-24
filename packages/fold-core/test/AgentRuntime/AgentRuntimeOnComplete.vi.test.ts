import { expect, it } from '@effect/vitest';
import { Array as Arr, Predicate, Effect, Ref, Schema } from 'effect';

import { AgentRuntime, OnCompleteHookDecision, type HookConfig, type UserMessageLogEntry } from '../../src/index';
import { makeScriptedLanguageModel, textTurn } from '../TestLayers/ScriptedLanguageModel';
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools';
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers';
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers';

it.effect('onComplete continueWith appends a continuation user message and loops one more turn', () =>
    Effect.gen(function* () {
        const recorder = yield* makeEchoRecorder;
        const completions = yield* Ref.make(0);

        const hooks: HookConfig = {
            onComplete: [
                {
                    name: 'continue-once-judge',
                    handler: () =>
                        Ref.updateAndGet(completions, (count) => count + 1).pipe(
                            Effect.map((count) =>
                                count === 1
                                    ? OnCompleteHookDecision.members[1].make({ text: 'keep going' })
                                    : OnCompleteHookDecision.members[0].make({}),
                            ),
                        ),
                },
            ],
        };

        const scripted = yield* makeScriptedLanguageModel([
            textTurn('First', undefined),
            textTurn('Second', undefined),
        ]);

        const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder), hooks);

        const result = yield* Effect.gen(function* () {
            const runtime = yield* AgentRuntime;

            yield* runtime.start(startInput({}));
            const finished = yield* runtime.run(runInput('do the task'));
            const entries = yield* collectEntries;

            return { finished, entries };
        }).pipe(Effect.provide(layer));

        expect(result.finished.outcome).toBe('completed');
        expect(result.finished.resultText).toBe('Second');

        expect(Arr.map(result.entries, (entry) => entry._tag)).toEqual([
            'agent_started',
            'system-message',
            'user-message',
            'assistant-message',
            'user-message',
            'assistant-message',
            'agent-finished',
        ]);

        const userMessages = Arr.filter(result.entries, (entry): entry is UserMessageLogEntry =>
            Predicate.isTagged(entry, 'user-message'),
        );

        const continuation = userMessages[1];

        const continuationJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            continuation?.message.content,
        );

        expect(continuationJson).toContain('keep going');

        expect(yield* Ref.get(completions)).toBe(2);
    }),
);
