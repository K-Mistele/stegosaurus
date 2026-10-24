import { expect, it } from '@effect/vitest';
import { Array as Arr, Effect, Option, Predicate, Schema } from 'effect';

import { defineToolState, layerHookRunner, toolStateForAgent, ToolRuntime } from '../../src/index';
import { layerStatefulEchoTool, makeEchoRecorder } from '../TestLayers/TestTools';
import {
    agentId,
    collectEntries,
    makeAssistantToolCall,
    toolCallId,
    toolRuntimeBaseLayer,
} from './ToolRuntimeTestHelpers';
import { ContinueDecision } from '../TestLayers/HookDecisions';

const AuditState = defineToolState({
    namespace: 'audit',
    keys: {
        seen: Schema.Finite,
    },
});

it.effect('a preToolUse hook writes durable state in its declared namespace, separate from the tool namespace', () =>
    Effect.gen(function* () {
        const recorder = yield* makeEchoRecorder;

        // The hook name differs from its declared ToolState namespace ('audit'), proving the persisted
        // namespace comes from the AuditState definition rather than the hook's name.
        const hookLayer = layerHookRunner({
            preToolUse: [
                {
                    name: 'audit-hook',
                    tools: ['echo'],
                    handler: ({ params }) =>
                        Effect.gen(function* () {
                            const seen = (yield* AuditState.get('seen')) ?? 0;
                            yield* AuditState.set('seen', seen + 1);

                            return ContinueDecision.make({ params });
                        }),
                },
            ],
        });

        const layer = toolRuntimeBaseLayer(hookLayer, layerStatefulEchoTool(recorder));

        const result = yield* Effect.gen(function* () {
            const runtime = yield* ToolRuntime;

            const settlement = yield* runtime.settle({
                agentId,
                parentAgentId: null,
                assistantMessage: makeAssistantToolCall({ text: 'state-value' }),
            });

            const entries = yield* collectEntries;

            return {
                settlement,
                entries,
                hookState: toolStateForAgent(entries, agentId, 'audit'),
                toolState: toolStateForAgent(entries, agentId, 'echo'),
            };
        }).pipe(Effect.provide(layer));

        const stateEntries = Arr.filter(result.entries, (entry) => Predicate.isTagged(entry, 'tool_state'));
        expect(Arr.map(stateEntries, (entry) => entry.namespace).sort()).toEqual(['audit', 'echo']);

        const auditEntry = Option.getOrUndefined(Arr.findFirst(stateEntries, (entry) => entry.namespace === 'audit'));
        expect(auditEntry).toMatchObject({
            agentId,
            toolCallId,
            key: 'seen',
            value: 1,
        });

        expect(result.hookState).toEqual({ seen: 1 });
        expect(result.toolState).toEqual({ last: 'state-value' });
        expect(result.settlement.toolResults).toHaveLength(1);
    }),
);
