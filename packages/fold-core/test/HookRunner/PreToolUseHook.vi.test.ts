import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { AgentId, HookRunner, ToolCallId, type PreToolUseHook } from '../../src';
import { runWithHookRunner } from '../TestLayers/HookRunnerTestHarness';
import { ContinueDecision, ReplaceResultDecision } from '../TestLayers/HookDecisions';

describe('HookRunner preToolUse hooks', () => {
    it.effect('runs hooks in order and passes updated params to the next hook', () =>
        Effect.gen(function* () {
            const calls: Array<unknown> = [];

            const hooks: ReadonlyArray<PreToolUseHook> = [
                {
                    name: 'first',
                    handler: ({ params }) => {
                        calls.push(params);

                        return Effect.succeed(ContinueDecision.make({ params: { step: 1 } }));
                    },
                },
                {
                    name: 'second',
                    handler: ({ params }) => {
                        calls.push(params);

                        return Effect.succeed(ContinueDecision.make({ params: { step: 2 } }));
                    },
                },
            ];

            const result = yield* runWithHookRunner(
                { preToolUse: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.preToolUse({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        toolCallId: ToolCallId.create(),
                        toolName: 'echo',
                        params: { step: 0 },
                    });
                }),
            );

            expect(calls).toEqual([{ step: 0 }, { step: 1 }]);
            expect(result).toEqual(ContinueDecision.make({ params: { step: 2 } }));
        }),
    );

    it.effect('runs only hooks matching the tool filter', () =>
        Effect.gen(function* () {
            const calls: Array<string> = [];

            const hooks: ReadonlyArray<PreToolUseHook> = [
                {
                    name: 'skipped',
                    tools: ['read'],
                    handler: ({ params }) => {
                        calls.push('skipped');

                        return Effect.succeed(ContinueDecision.make({ params }));
                    },
                },
                {
                    name: 'matched',
                    tools: ['echo'],
                    handler: ({ params }) => {
                        calls.push('matched');

                        return Effect.succeed(ContinueDecision.make({ params: { params, matched: true } }));
                    },
                },
            ];

            const result = yield* runWithHookRunner(
                { preToolUse: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.preToolUse({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        toolCallId: ToolCallId.create(),
                        toolName: 'echo',
                        params: { original: true },
                    });
                }),
            );

            expect(calls).toEqual(['matched']);
            expect(result).toEqual(ContinueDecision.make({ params: { params: { original: true }, matched: true } }));
        }),
    );

    it.effect('returns replaceResult and short-circuits later hooks', () =>
        Effect.gen(function* () {
            const calls: Array<string> = [];

            const hooks: ReadonlyArray<PreToolUseHook> = [
                {
                    name: 'replace',
                    handler: () => {
                        calls.push('replace');

                        return Effect.succeed(
                            ReplaceResultDecision.make({
                                result: { blocked: true },
                                isFailure: true,
                            }),
                        );
                    },
                },
                {
                    name: 'never',
                    handler: ({ params }) => {
                        calls.push('never');

                        return Effect.succeed(ContinueDecision.make({ params }));
                    },
                },
            ];

            const result = yield* runWithHookRunner(
                { preToolUse: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.preToolUse({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        toolCallId: ToolCallId.create(),
                        toolName: 'echo',
                        params: { original: true },
                    });
                }),
            );

            expect(calls).toEqual(['replace']);
            expect(result).toEqual(ReplaceResultDecision.make({ result: { blocked: true }, isFailure: true }));
        }),
    );
});
