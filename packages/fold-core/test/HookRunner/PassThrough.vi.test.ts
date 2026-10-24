import { expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { Prompt } from 'effect/ai';

import {
    AgentId,
    HookRunner,
    OnCompleteHookDecision,
    PostToolUseHookDecision,
    PreRequestHookDecision,
    PreToolUseHookDecision,
    ToolCallId,
} from '../../src/index';
import { hookRunnerNoop } from '../TestLayers/NoOpHookRunner';
import { layerNoopStopController } from '../TestLayers/TestStopController';
import {
    CompleteDecision,
    ContinueDecision,
    ContinueWithDecision,
    KeepDecision,
    ReplaceDecision,
    ReplaceResultDecision,
    UnchangedDecision,
} from '../TestLayers/HookDecisions';

const makePrompt = () =>
    Prompt.fromMessages([
        Prompt.userMessage({
            content: [Prompt.textPart({ text: 'hello' })],
        }),
    ]);

it.effect('layerNoHooks returns pass-through decisions', () =>
    Effect.gen(function* () {
        const hooks = yield* HookRunner;
        const agentId = AgentId.create();
        const toolCallId = ToolCallId.create();
        const prompt = makePrompt();
        const params = { text: 'hello' };

        const preRequest = yield* hooks.preRequest({
            agentId,
            parentAgentId: null,
            prompt,
        });

        const preToolUse = yield* hooks.preToolUse({
            agentId,
            parentAgentId: null,
            toolCallId,
            toolName: 'echo',
            params,
        });

        const postToolUse = yield* hooks.postToolUse({
            agentId,
            parentAgentId: null,
            toolCallId,
            toolName: 'echo',
            originalInput: params,
            executedInput: params,
            handlerResult: { echoed: 'hello' },
            result: { echoed: 'hello' },
            isFailure: false,
        });

        const onComplete = yield* hooks.onComplete({
            agentId,
            parentAgentId: null,
            resultText: 'done',
        });

        expect(preRequest).toEqual(UnchangedDecision.make({}));
        expect(preToolUse).toEqual(ContinueDecision.make({ params }));
        expect(postToolUse).toEqual(KeepDecision.make({}));
        expect(onComplete).toEqual(CompleteDecision.make({}));
    }).pipe(Effect.provide(Layer.mergeAll(hookRunnerNoop, layerNoopStopController))),
);

it.effect('defines schema-derived hook decision types', () =>
    Effect.gen(function* () {
        const preRequest = yield* Schema.decodeEffect(PreRequestHookDecision)(UnchangedDecision.make({}));

        const preToolUse = yield* Schema.decodeEffect(PreToolUseHookDecision)(
            ReplaceResultDecision.make({
                result: { blocked: true },
                isFailure: true,
            }),
        );

        const postToolUse = yield* Schema.decodeEffect(PostToolUseHookDecision)(
            ReplaceDecision.make({
                result: { rewritten: true },
                isFailure: false,
            }),
        );

        const onComplete = yield* Schema.decodeEffect(OnCompleteHookDecision)(
            ContinueWithDecision.make({
                text: 'keep going',
            }),
        );

        expect(preRequest).toEqual(UnchangedDecision.make({}));
        expect(preToolUse).toEqual(
            ReplaceResultDecision.make({
                result: { blocked: true },
                isFailure: true,
            }),
        );
        expect(postToolUse).toEqual(
            ReplaceDecision.make({
                result: { rewritten: true },
                isFailure: false,
            }),
        );
        expect(onComplete).toEqual(
            ContinueWithDecision.make({
                text: 'keep going',
            }),
        );
    }),
);
