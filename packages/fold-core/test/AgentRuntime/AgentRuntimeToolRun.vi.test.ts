import { expect, it } from '@effect/vitest';
import { Array as Arr, Predicate, Effect, Option, Ref, String as Str } from 'effect';
import type { Prompt } from 'effect/ai';

import { AgentRuntime, type AssistantMessageLogEntry, type ToolResultLogEntry } from '../../src/index';
import { makeScriptedLanguageModel, textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel';
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools';
import { collectEntries } from '../ToolRuntime/ToolRuntimeTestHelpers';
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers';

it.effect('runs a tool turn end to end, rewriting and restoring provider tool-call ids', () =>
    Effect.gen(function* () {
        const recorder = yield* makeEchoRecorder;

        const scripted = yield* makeScriptedLanguageModel([
            toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: 'hi' } }], undefined),
            textTurn('Tool said hi', undefined),
        ]);

        const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder));

        const result = yield* Effect.gen(function* () {
            const runtime = yield* AgentRuntime;

            yield* runtime.start(startInput({}));
            const finished = yield* runtime.run(runInput('use the echo tool'));
            const entries = yield* collectEntries;
            const calls = yield* Ref.get(recorder.calls);

            return { finished, entries, calls };
        }).pipe(Effect.provide(layer));

        expect(result.calls).toEqual(['hi']);
        expect(result.finished.outcome).toBe('completed');
        expect(result.finished.resultText).toBe('Tool said hi');

        expect(Arr.map(result.entries, (entry) => entry._tag)).toEqual([
            'agent_started',
            'system-message',
            'user-message',
            'assistant-message',
            'tool-result',
            'assistant-message',
            'agent-finished',
        ]);

        // The persisted assistant tool-call has a minted fold id; the provider id is stashed in options.
        const assistant = Option.getOrUndefined(
            Arr.findFirst(result.entries, (entry): entry is AssistantMessageLogEntry =>
                Predicate.isTagged(entry, 'assistant-message'),
            ),
        );

        const assistantContent = assistant?.message.content;

        if (Predicate.isString(assistantContent) || assistantContent === undefined) {
            throw new Error('expected structured assistant content');
        }

        const persistedToolCall = Option.getOrUndefined(
            Arr.findFirst(assistantContent, (part) => part.type === 'tool-call'),
        );

        if (persistedToolCall?.type !== 'tool-call') throw new Error('expected a persisted tool-call part');

        expect(Str.startsWith('tool_call_')(persistedToolCall.id)).toBe(true);
        expect(persistedToolCall.id).not.toBe('provider-call-1');
        expect(persistedToolCall.options).toMatchObject({ fold: { providerToolCallId: 'provider-call-1' } });

        // The durable tool result is grouped under the minted fold id.
        const toolResult = Option.getOrUndefined(
            Arr.findFirst(result.entries, (entry): entry is ToolResultLogEntry =>
                Predicate.isTagged(entry, 'tool-result'),
            ),
        );

        expect(toolResult?.toolCallId).toBe(persistedToolCall.id);

        // The continuation request restores the provider's original id on both sides of the exchange.
        const prompts = yield* scripted.prompts;
        expect(prompts).toHaveLength(2);

        const continuation = prompts[1];

        if (continuation === undefined) throw new Error('expected a continuation prompt');

        const promptAssistant = Option.getOrUndefined(
            Arr.findFirst(
                continuation.content,
                (message): message is Prompt.AssistantMessage => message.role === 'assistant',
            ),
        );

        const promptToolCall =
            promptAssistant === undefined
                ? undefined
                : Option.getOrUndefined(Arr.findFirst(promptAssistant.content, (part) => part.type === 'tool-call'));

        if (promptToolCall?.type !== 'tool-call') throw new Error('expected a tool-call part in the continuation');
        expect(promptToolCall.id).toBe('provider-call-1');
        expect(promptToolCall.params).toEqual({ text: 'hi' });

        const promptToolMessage = Option.getOrUndefined(
            Arr.findFirst(continuation.content, (message): message is Prompt.ToolMessage => message.role === 'tool'),
        );

        const promptToolResult =
            promptToolMessage === undefined
                ? undefined
                : Option.getOrUndefined(
                      Arr.findFirst(promptToolMessage.content, (part) => part.type === 'tool-result'),
                  );

        if (promptToolResult?.type !== 'tool-result')
            throw new Error('expected a tool-result part in the continuation');
        expect(promptToolResult.id).toBe('provider-call-1');
        expect(promptToolResult.result).toEqual({ echoed: 'hi' });
    }),
);
