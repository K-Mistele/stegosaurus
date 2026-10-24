import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { AgentId, HookRunner, type OnCompleteHook } from '../../src';
import { runWithHookRunner } from '../TestLayers/HookRunnerTestHarness';
import { CompleteDecision, ContinueWithDecision } from '../TestLayers/HookDecisions';

describe('HookRunner onComplete hooks', () => {
    it.effect('runs complete hooks in order', () =>
        Effect.gen(function* () {
            const calls: Array<string> = [];

            const hooks: ReadonlyArray<OnCompleteHook> = [
                {
                    name: 'first',
                    handler: () => {
                        calls.push('first');

                        return Effect.succeed(CompleteDecision.make({}));
                    },
                },
                {
                    name: 'second',
                    handler: () => {
                        calls.push('second');

                        return Effect.succeed(CompleteDecision.make({}));
                    },
                },
            ];

            const result = yield* runWithHookRunner(
                { onComplete: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.onComplete({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        resultText: 'done',
                    });
                }),
            );

            expect(calls).toEqual(['first', 'second']);
            expect(result).toEqual(CompleteDecision.make({}));
        }),
    );

    it.effect('returns continueWith and short-circuits later hooks', () =>
        Effect.gen(function* () {
            const calls: Array<string> = [];

            const hooks: ReadonlyArray<OnCompleteHook> = [
                {
                    name: 'continue',
                    handler: () => {
                        calls.push('continue');

                        return Effect.succeed(ContinueWithDecision.make({ text: 'keep going' }));
                    },
                },
                {
                    name: 'never',
                    handler: () => {
                        calls.push('never');

                        return Effect.succeed(CompleteDecision.make({}));
                    },
                },
            ];

            const result = yield* runWithHookRunner(
                { onComplete: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.onComplete({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        resultText: 'done',
                    });
                }),
            );

            expect(calls).toEqual(['continue']);
            expect(result).toEqual(ContinueWithDecision.make({ text: 'keep going' }));
        }),
    );
});
