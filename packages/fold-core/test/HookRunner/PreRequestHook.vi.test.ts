import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Prompt } from 'effect/ai';

import { AgentId, HookRunner, type PreRequestHook } from '../../src';
import { runWithHookRunner } from '../TestLayers/HookRunnerTestHarness';
import { ChangedDecision, UnchangedDecision } from '../TestLayers/HookDecisions';

const makePrompt = (text: string) =>
    Prompt.fromMessages([
        Prompt.userMessage({
            content: [Prompt.textPart({ text })],
        }),
    ]);

describe('HookRunner preRequest hooks', () => {
    it.effect('runs hooks in order and passes changed prompt to the next hook', () =>
        Effect.gen(function* () {
            const originalPrompt = makePrompt('original');
            const firstPrompt = makePrompt('first');
            const secondPrompt = makePrompt('second');
            const calls: Array<unknown> = [];

            const hooks: ReadonlyArray<PreRequestHook> = [
                {
                    name: 'first',
                    handler: ({ prompt }) => {
                        calls.push(prompt);

                        return Effect.succeed(ChangedDecision.make({ prompt: firstPrompt }));
                    },
                },
                {
                    name: 'second',
                    handler: ({ prompt }) => {
                        calls.push(prompt);

                        return Effect.succeed(ChangedDecision.make({ prompt: secondPrompt }));
                    },
                },
            ];

            const result = yield* runWithHookRunner(
                { preRequest: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.preRequest({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        prompt: originalPrompt,
                    });
                }),
            );

            expect(calls).toEqual([originalPrompt, firstPrompt]);
            expect(result).toEqual(ChangedDecision.make({ prompt: secondPrompt }));
        }),
    );

    it.effect('returns changed when an earlier hook changes the prompt and a later hook leaves it unchanged', () =>
        Effect.gen(function* () {
            const changedPrompt = makePrompt('changed');

            const hooks: ReadonlyArray<PreRequestHook> = [
                {
                    name: 'change',
                    handler: () => Effect.succeed(ChangedDecision.make({ prompt: changedPrompt })),
                },
                {
                    name: 'unchanged',
                    handler: () => Effect.succeed(UnchangedDecision.make({})),
                },
            ];

            const result = yield* runWithHookRunner(
                { preRequest: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.preRequest({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        prompt: makePrompt('original'),
                    });
                }),
            );

            expect(result).toEqual(ChangedDecision.make({ prompt: changedPrompt }));
        }),
    );
});
