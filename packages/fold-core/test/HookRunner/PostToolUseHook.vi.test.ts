import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { AgentId, HookRunner, ToolCallId, type PostToolUseHook } from '../../src';
import { runWithHookRunner } from '../TestLayers/HookRunnerTestHarness';
import { KeepDecision, ReplaceDecision } from '../TestLayers/HookDecisions';

describe('HookRunner postToolUse hooks', () => {
    it.effect('runs hooks in order and passes replaced result to the next hook', () =>
        Effect.gen(function* () {
            const calls: Array<unknown> = [];

            const hooks: ReadonlyArray<PostToolUseHook> = [
                {
                    name: 'first',
                    handler: ({ result, isFailure }) => {
                        calls.push({ result, isFailure });

                        return Effect.succeed(ReplaceDecision.make({ result: { step: 1 }, isFailure: true }));
                    },
                },
                {
                    name: 'second',
                    handler: ({ result, isFailure }) => {
                        calls.push({ result, isFailure });

                        return Effect.succeed(ReplaceDecision.make({ result: { step: 2 }, isFailure: false }));
                    },
                },
            ];

            const result = yield* runWithHookRunner(
                { postToolUse: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.postToolUse({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        toolCallId: ToolCallId.create(),
                        toolName: 'echo',
                        originalInput: { text: 'original' },
                        executedInput: { text: 'executed' },
                        handlerResult: { step: 0 },
                        result: { step: 0 },
                        isFailure: false,
                    });
                }),
            );

            expect(calls).toEqual([
                { result: { step: 0 }, isFailure: false },
                { result: { step: 1 }, isFailure: true },
            ]);
            expect(result).toEqual(ReplaceDecision.make({ result: { step: 2 }, isFailure: false }));
        }),
    );

    it.effect('keeps the accumulated result when a later hook returns keep', () =>
        Effect.gen(function* () {
            const hooks: ReadonlyArray<PostToolUseHook> = [
                {
                    name: 'replace',
                    handler: () =>
                        Effect.succeed(ReplaceDecision.make({ result: { replaced: true }, isFailure: true })),
                },
                {
                    name: 'keep',
                    handler: () => Effect.succeed(KeepDecision.make({})),
                },
            ];

            const result = yield* runWithHookRunner(
                { postToolUse: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.postToolUse({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        toolCallId: ToolCallId.create(),
                        toolName: 'echo',
                        originalInput: { text: 'original' },
                        executedInput: { text: 'executed' },
                        handlerResult: { original: true },
                        result: { original: true },
                        isFailure: false,
                    });
                }),
            );

            expect(result).toEqual(ReplaceDecision.make({ result: { replaced: true }, isFailure: true }));
        }),
    );

    it.effect('runs only hooks matching the tool filter', () =>
        Effect.gen(function* () {
            const calls: Array<string> = [];

            const hooks: ReadonlyArray<PostToolUseHook> = [
                {
                    name: 'skipped',
                    tools: ['read'],
                    handler: () => {
                        calls.push('skipped');

                        return Effect.succeed(ReplaceDecision.make({ result: { skipped: true }, isFailure: true }));
                    },
                },
                {
                    name: 'matched',
                    tools: ['echo'],
                    handler: () => {
                        calls.push('matched');

                        return Effect.succeed(ReplaceDecision.make({ result: { matched: true }, isFailure: false }));
                    },
                },
            ];

            const result = yield* runWithHookRunner(
                { postToolUse: hooks },
                Effect.gen(function* () {
                    const hookRunner = yield* HookRunner;

                    return yield* hookRunner.postToolUse({
                        agentId: AgentId.create(),
                        parentAgentId: null,
                        toolCallId: ToolCallId.create(),
                        toolName: 'echo',
                        originalInput: { text: 'original' },
                        executedInput: { text: 'executed' },
                        handlerResult: { original: true },
                        result: { original: true },
                        isFailure: false,
                    });
                }),
            );

            expect(calls).toEqual(['matched']);
            expect(result).toEqual(ReplaceDecision.make({ result: { matched: true }, isFailure: false }));
        }),
    );
});
