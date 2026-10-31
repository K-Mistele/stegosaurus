import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { Array as Arr, Deferred, Effect, Layer, Predicate, Ref, Schema } from 'effect';
import { Prompt, Tool } from 'effect/ai';

import {
    defineToolState,
    type EventLog,
    type HookRunner,
    type Ids,
    layerInMemoryEventLog,
    liveToolRuntimeLayer,
    layerHookRunner,
    ToolCallId,
    ToolRuntime,
    ToolState,
    toolsetLayerFromToolkit,
    toolStateForAgent,
} from '../../src/index';
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime';
import { hookRunnerNoop } from '../TestLayers/NoOpHookRunner';
import { agentId, collectEntries, layerNoopToolEvents } from './ToolRuntimeTestHelpers';
import { ContinueDecision } from '../TestLayers/HookDecisions';
import { erasedHandler, erasedToolkit } from '../TestLayers/TestTools';

const toolCallIdA = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa');

const toolCallIdB = ToolCallId.make('tool_call_bbbbbbbbbbbbbbbbbbbbbbbb');

const ProbeState = defineToolState({
    namespace: 'probe',
    keys: {
        shared: Schema.String,
    },
});

const ProbeTool = Tool.make('probe', {
    description: 'Probes shared tool state under parallel settlement.',
    parameters: Schema.Struct({ label: Schema.String }),
    success: Schema.Struct({ done: Schema.Boolean }),
    failure: Schema.Struct({ message: Schema.String }),
    failureMode: 'return',
    dependencies: [ToolState],
});

const ProbeToolkit = erasedToolkit(ProbeTool);

type ProbeHandlers = Tool.HandlersFor<typeof ProbeToolkit.tools>;

const probeRuntimeLayer = (
    hookLayer: Layer.Layer<HookRunner, never, EventLog | Ids>,
    handlerLayer: Layer.Layer<ProbeHandlers>,
) => {
    const memoryLayer = layerInMemoryEventLog;
    const idsLayer = layerDeterministicRuntime({ startMillis: 1_000, stepMillis: 0 });
    const hookDeps = Layer.mergeAll(memoryLayer, idsLayer);

    return liveToolRuntimeLayer.pipe(
        Layer.provideMerge(
            Layer.mergeAll(
                memoryLayer,
                idsLayer,
                toolsetLayerFromToolkit(ProbeToolkit).pipe(Layer.provide(handlerLayer)),
                hookLayer.pipe(Layer.provide(hookDeps)),
                layerNoopToolEvents,
                NodeFileSystem.layer,
            ),
        ),
    );
};

const makeProbeAssistantMessage = (calls: ReadonlyArray<{ id: ToolCallId; label: string }>): Prompt.AssistantMessage =>
    Prompt.assistantMessage({
        content: Arr.map(calls, ({ id, label }) =>
            Prompt.toolCallPart({
                id,
                name: 'probe',
                params: { label },
                providerExecuted: false,
            }),
        ),
    });

describe('ToolRuntime handler state snapshots', () => {
    it.effect('parallel calls read a fork-point snapshot plus their own writes, never each other', () =>
        Effect.gen(function* () {
            const aWrote = yield* Deferred.make<void>();
            const bDone = yield* Deferred.make<void>();

            const observations = yield* Ref.make<{
                bBeforeOwnWrite?: unknown;
                bAfterOwnWrite?: unknown;
                aAfterBWrote?: unknown;
            }>({});

            const handlerLayer = ProbeToolkit.toLayer(
                ProbeToolkit.of({
                    probe: erasedHandler(ProbeTool.parametersSchema, ({ label }) =>
                        Effect.gen(function* () {
                            if (label === 'a') {
                                yield* ProbeState.set('shared', 'a');
                                yield* Deferred.succeed(aWrote, undefined);
                                yield* Deferred.await(bDone);

                                const aAfterBWrote = yield* ProbeState.get('shared');
                                yield* Ref.update(observations, (state) => ({ ...state, aAfterBWrote }));
                            } else {
                                yield* Deferred.await(aWrote);

                                const bBeforeOwnWrite = yield* ProbeState.get('shared');
                                yield* ProbeState.set('shared', 'b');
                                const bAfterOwnWrite = yield* ProbeState.get('shared');

                                yield* Ref.update(observations, (state) => ({
                                    ...state,
                                    bBeforeOwnWrite,
                                    bAfterOwnWrite,
                                }));
                                yield* Deferred.succeed(bDone, undefined);
                            }

                            return { done: true };
                        }),
                    ),
                }),
            );

            const layer = probeRuntimeLayer(hookRunnerNoop, handlerLayer);

            const result = yield* Effect.gen(function* () {
                const runtime = yield* ToolRuntime;

                const settlement = yield* runtime.settle({
                    agentId,
                    parentAgentId: null,
                    assistantMessage: makeProbeAssistantMessage([
                        { id: toolCallIdA, label: 'a' },
                        { id: toolCallIdB, label: 'b' },
                    ]),
                });

                const entries = yield* collectEntries;

                return { settlement, entries };
            }).pipe(Effect.provide(layer));

            const observed = yield* Ref.get(observations);

            // B ran strictly after A's write landed in the log, yet its snapshot hides it.
            expect(observed.bBeforeOwnWrite).toBeNull();
            // Each call sees its own writes.
            expect(observed.bAfterOwnWrite).toBe('b');
            expect(observed.aAfterBWrote).toBe('a');

            // Both writes are durable facts in the log, and the next batch folds the last writer.
            const stateEntries = Arr.filter(result.entries, (entry) => Predicate.isTagged(entry, 'tool_state'));
            expect(Arr.map(stateEntries, (entry) => entry.value)).toEqual(['a', 'b']);
            expect(toolStateForAgent(result.entries, agentId, 'probe')).toEqual({ shared: 'b' });
            expect(result.settlement.toolResults).toHaveLength(2);
        }),
    );

    it.effect('handlers observe state written by preToolUse hooks before the fork point', () =>
        Effect.gen(function* () {
            const observed = yield* Ref.make<unknown>('unset');

            // The hook shares state with the tool because both use the same ProbeState definition, not
            // because of any name match - the hook name deliberately differs from the declared namespace.
            const hookLayer = layerHookRunner({
                preToolUse: [
                    {
                        name: 'probe-seed',
                        tools: ['probe'],
                        handler: ({ params }) =>
                            Effect.gen(function* () {
                                yield* ProbeState.set('shared', 'hooked');

                                return ContinueDecision.make({ params });
                            }),
                    },
                ],
            });

            const handlerLayer = ProbeToolkit.toLayer(
                ProbeToolkit.of({
                    probe: () =>
                        Effect.gen(function* () {
                            const shared = yield* ProbeState.get('shared');
                            yield* Ref.set(observed, shared);

                            return { done: true };
                        }),
                }),
            );

            const layer = probeRuntimeLayer(hookLayer, handlerLayer);

            yield* Effect.gen(function* () {
                const runtime = yield* ToolRuntime;

                yield* runtime.settle({
                    agentId,
                    parentAgentId: null,
                    assistantMessage: makeProbeAssistantMessage([{ id: toolCallIdA, label: 'a' }]),
                });
            }).pipe(Effect.provide(layer));

            const shared = yield* Ref.get(observed);
            expect(shared).toBe('hooked');
        }),
    );
});
