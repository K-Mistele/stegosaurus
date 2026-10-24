/**
 * LEARNING TEST for the ScriptedLanguageModel test layer.
 *
 * We generally avoid testing test layers. This file exists as executable documentation of how the
 * scripted model works: each `streamText` call consumes the next scripted turn (text, tool calls,
 * or a provider failure) and records the prompt it received, so runtime tests can script whole
 * conversations and assert exactly what the runtime sent to the model. See the AgentRuntime tests
 * for tool-call turns driven through the full loop.
 */
import { expect, it } from '@effect/vitest';
import { Array as Arr, Effect, Result, Schema, Stream } from 'effect';
import { LanguageModel } from 'effect/ai';

import { failureTurn, makeScriptedLanguageModel, textTurn } from './ScriptedLanguageModel';

it.effect('consumes turns in order and captures each prompt it was sent', () =>
    Effect.gen(function* () {
        const scripted = yield* makeScriptedLanguageModel([textTurn('Hello!', undefined), failureTurn('rate limited')]);

        const run = Effect.gen(function* () {
            const model = yield* LanguageModel.LanguageModel;

            const parts = yield* Stream.runCollect(model.streamText({ prompt: 'What is fold?' }));
            const failure = yield* Stream.runCollect(model.streamText({ prompt: 'and again?' })).pipe(Effect.result);

            return { parts, failure };
        });

        const { parts, failure } = yield* run.pipe(Effect.provide(scripted.layer));

        // A text turn streams start/delta/end plus a finish part carrying usage.
        expect(Arr.map(parts, (part) => part.type)).toEqual(['text-start', 'text-delta', 'text-end', 'finish']);

        // A failure turn fails the stream like a real provider error would.
        expect(Result.isFailure(failure)).toBe(true);

        // Every request's prompt is captured in order for assertions.
        const prompts = yield* scripted.prompts;
        expect(prompts).toHaveLength(2);
        const firstPromptJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(prompts[0]?.content);

        expect(firstPromptJson).toContain('What is fold?');

        expect(yield* scripted.remainingTurns).toBe(0);
    }),
);
