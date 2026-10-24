import { it, expect } from '@effect/vitest';
import { Array as Arr, Effect, Layer, Predicate, Schema, Stream } from 'effect';
import { Prompt } from 'effect/ai';

import {
    EventLog,
    Ids,
    layerInMemoryEventLog,
    LogEntryInputs,
    makeCompactionService,
    messagesForAgent,
    OpenAiReasoningWithEffort,
    runtimeForAgent,
    toolStateForAgent,
    type ToolCallId,
    type ActiveModel,
    type LogEntry,
    type SystemMessageEncoded,
    type ToolMessageEncoded,
    type UserMessageEncoded,
} from '../../src/index';
import { layerDeterministicRuntime } from '../TestLayers/DeterministicRuntime';
import { makeScriptedLanguageModel, textTurn } from '../TestLayers/ScriptedLanguageModel';

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const testLayer = Layer.mergeAll(layerInMemoryEventLog, layerDeterministicRuntime({ startMillis: 10_000 }));

const model: ActiveModel = {
    providerId: 'primary',
    providerKind: 'openai-compatible',
    modelId: 'gpt-test',
    role: 'smart',
    requestedReasoningLevel: 'low',
    reasoning: OpenAiReasoningWithEffort.make({ effort: 'low' }),
};

const fastModel: ActiveModel = {
    providerId: 'primary',
    providerKind: 'openai-compatible',
    modelId: 'gpt-test-fast',
    role: 'fast',
    requestedReasoningLevel: 'minimal',
    reasoning: OpenAiReasoningWithEffort.make({ effort: 'minimal' }),
};

const systemMessage = (content: string): Effect.Effect<SystemMessageEncoded> =>
    Schema.encodeUnknownEffect(Prompt.SystemMessage)(Prompt.systemMessage({ content })).pipe(Effect.orDie);

const userMessage = (text: string): Effect.Effect<UserMessageEncoded> =>
    Schema.encodeUnknownEffect(Prompt.UserMessage)(Prompt.userMessage({ content: [Prompt.textPart({ text })] })).pipe(
        Effect.orDie,
    );

const assistantWithToolCalls = (toolCallIds: ReadonlyArray<ToolCallId>) =>
    Schema.encodeUnknownEffect(Prompt.AssistantMessage)(
        Prompt.assistantMessage({
            content: Arr.map(toolCallIds, (id, index) =>
                Prompt.toolCallPart({ id, name: `tool_${index}`, params: { index }, providerExecuted: false }),
            ),
        }),
    ).pipe(Effect.orDie);

const assistantText = (text: string) =>
    Schema.encodeUnknownEffect(Prompt.AssistantMessage)(
        Prompt.assistantMessage({ content: [Prompt.textPart({ text })] }),
    ).pipe(Effect.orDie);

const toolMessage = (toolCallId: ToolCallId, index: number): Effect.Effect<ToolMessageEncoded> =>
    Schema.encodeUnknownEffect(Prompt.ToolMessage)(
        Prompt.toolMessage({
            content: [
                Prompt.toolResultPart({
                    id: toolCallId,
                    name: `tool_${index}`,
                    isFailure: false,
                    result: { index },
                    providerExecuted: false,
                }),
            ],
        }),
    ).pipe(Effect.orDie);

const messageId = Effect.flatMap(Ids, (ids) => ids.makeMessageId);

const stateId = Effect.flatMap(Ids, (ids) => ids.makeStateId);

const toolCallId = Effect.flatMap(Ids, (ids) => ids.makeToolCallId);

const agentId = Effect.flatMap(Ids, (ids) => ids.makeAgentId);

const appendRoot = (tools: ReadonlyArray<string> = ['read']) =>
    Effect.gen(function* () {
        const ids = yield* Ids;
        const log = yield* EventLog;
        const rootAgentId = yield* ids.makeAgentId;

        yield* log.append(
            LogEntryInputs.session_started({
                agentId: null,
                parentAgentId: null,
                toolCallId: null,
                cwd: '/tmp/project',
                sessionId: yield* ids.makeSessionId,
                rootAgentId,
                meta: {},
            }),
        );
        yield* log.append(
            LogEntryInputs.agent_started({
                agentId: rootAgentId,
                parentAgentId: null,
                toolCallId: null,
                mode: 'fresh',
                model,
                tools: [...tools],
                skill: null,
                fork: null,
                agentType: null,
            }),
        );

        return rootAgentId;
    });

const readEntries = Effect.flatMap(EventLog, (log) => Stream.runCollect(log.entries()));

const lastSeq = (entries: ReadonlyArray<LogEntry>) => {
    const entry = entries.at(-1);

    if (entry === undefined) throw new Error('Expected at least one log entry');

    return entry.seq;
};

it.effect('projects runtime state and tool state from the log', () =>
    Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
            const log = yield* EventLog;
            const rootAgentId = yield* appendRoot(['read']);
            const firstToolCallId = yield* toolCallId;

            yield* log.append(
                LogEntryInputs['model-change']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    model: fastModel,
                    reason: 'test',
                }),
            );
            yield* log.append(
                LogEntryInputs['thinking-change']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    reasoningLevel: 'high',
                    reason: 'test',
                }),
            );
            yield* log.append(
                LogEntryInputs['tools-change']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    tools: ['read', 'bash'],
                    reason: 'test',
                }),
            );
            yield* log.append(
                LogEntryInputs.tool_state({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: firstToolCallId,
                    namespace: 'read',
                    stateId: yield* stateId,
                    key: 'a.txt',
                    value: { hash: 'old' },
                }),
            );
            yield* log.append(
                LogEntryInputs.tool_state({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: firstToolCallId,
                    namespace: 'read',
                    stateId: yield* stateId,
                    key: 'a.txt',
                    value: null,
                }),
            );
            yield* log.append(
                LogEntryInputs.tool_state({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: firstToolCallId,
                    namespace: 'read',
                    stateId: yield* stateId,
                    key: 'b.txt',
                    value: { hash: 'new' },
                }),
            );

            const entries = yield* readEntries;

            return { entries, rootAgentId };
        }).pipe(Effect.provide(testLayer));

        const runtime = runtimeForAgent(result.entries, result.rootAgentId);
        const readState = toolStateForAgent(result.entries, result.rootAgentId, 'read');

        expect(runtime.activeModel?.modelId).toBe('gpt-test-fast');
        expect(runtime.activeTools).toEqual(['read', 'bash']);
        expect(runtime.reasoningLevel).toBe('high');
        expect(runtime.isRunning).toBe(true);
        expect(readState).toEqual({ 'b.txt': { hash: 'new' } });
    }),
);

it.effect('projects messages with the latest leading system message and assistant tool-call ordering', () =>
    Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
            const log = yield* EventLog;
            const rootAgentId = yield* appendRoot();
            const firstToolCallId = yield* toolCallId;
            const secondToolCallId = yield* toolCallId;

            yield* log.append(
                LogEntryInputs['system-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    messages: [yield* systemMessage('old system')],
                    placement: 'leading',
                }),
            );
            yield* log.append(
                LogEntryInputs['system-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    messages: [yield* systemMessage('new system'), yield* systemMessage('stay terse')],
                    placement: 'leading',
                }),
            );
            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* userMessage('hello'),
                }),
            );
            yield* log.append(
                LogEntryInputs['assistant-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* assistantWithToolCalls([firstToolCallId, secondToolCallId]),
                    finish: null,
                }),
            );
            yield* log.append(
                LogEntryInputs['tool-result']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: secondToolCallId,
                    messageId: yield* messageId,
                    message: yield* toolMessage(secondToolCallId, 1),
                }),
            );
            yield* log.append(
                LogEntryInputs['tool-result']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: firstToolCallId,
                    messageId: yield* messageId,
                    message: yield* toolMessage(firstToolCallId, 0),
                }),
            );

            return { entries: yield* readEntries, firstToolCallId, rootAgentId, secondToolCallId };
        }).pipe(Effect.provide(testLayer));

        const projected = messagesForAgent(result.entries, result.rootAgentId);

        expect(Arr.map(projected, (message) => message._tag)).toEqual([
            'system-message',
            'user-message',
            'assistant-message',
            'tool-result',
            'tool-result',
        ]);
        expect(projected[0]).toMatchObject({
            messages: [{ content: 'new system' }, { content: 'stay terse' }],
        });
        expect(projected[3]).toMatchObject({ toolCallId: result.firstToolCallId });
        expect(projected[4]).toMatchObject({ toolCallId: result.secondToolCallId });
    }),
);

it.effect('compaction cutoff covers every reordered tool result in its discarded prefix', () =>
    Effect.gen(function* () {
        const log = yield* EventLog;
        const ids = yield* Ids;
        const rootAgentId = yield* appendRoot();
        const firstToolCallId = yield* toolCallId;
        const secondToolCallId = yield* toolCallId;

        yield* log.append(
            LogEntryInputs['user-message']({
                agentId: rootAgentId,
                parentAgentId: null,
                toolCallId: null,
                messageId: yield* messageId,
                message: yield* userMessage('complete the tool batch'),
            }),
        );
        yield* log.append(
            LogEntryInputs['assistant-message']({
                agentId: rootAgentId,
                parentAgentId: null,
                toolCallId: null,
                messageId: yield* messageId,
                message: yield* assistantWithToolCalls([firstToolCallId, secondToolCallId]),
                finish: null,
            }),
        );

        // The second call finishes first, so its result is persisted before the first call's result.
        yield* log.append(
            LogEntryInputs['tool-result']({
                agentId: rootAgentId,
                parentAgentId: null,
                toolCallId: secondToolCallId,
                messageId: yield* messageId,
                message: yield* toolMessage(secondToolCallId, 1),
            }),
        );
        yield* log.append(
            LogEntryInputs['tool-result']({
                agentId: rootAgentId,
                parentAgentId: null,
                toolCallId: firstToolCallId,
                messageId: yield* messageId,
                message: yield* toolMessage(firstToolCallId, 0),
            }),
        );
        const firstToolResultSeq = lastSeq(yield* readEntries);

        // Keep this later message so compaction discards the full preceding tool exchange.
        yield* log.append(
            LogEntryInputs['user-message']({
                agentId: rootAgentId,
                parentAgentId: null,
                toolCallId: null,
                messageId: yield* messageId,
                message: yield* userMessage('continue after compaction'),
            }),
        );

        const entries = yield* readEntries;
        const scripted = yield* makeScriptedLanguageModel([textTurn('tool batch summary', undefined)]);

        const compaction = yield* makeCompactionService({
            enabled: true,
            thresholdTokens: 1,
            keepRecentTokens: 1,
        }).pipe(Effect.provide(scripted.layer));

        const plan = yield* compaction.plan({ agentId: rootAgentId, entries, model, trigger: 'threshold' });

        if (plan === null) throw new Error('expected a compaction plan');

        // Projection puts the second result last, but its smaller physical sequence must not become
        // the durable cutoff. Otherwise the first result survives after its assistant call is removed.
        expect(plan.replacesThroughSeq).toBe(firstToolResultSeq);

        yield* log.append(
            LogEntryInputs.compaction({
                agentId: rootAgentId,
                parentAgentId: null,
                toolCallId: null,
                compactionId: yield* ids.makeCompactionId,
                summary: plan.summary,
                replacesThroughSeq: plan.replacesThroughSeq,
                tokensBefore: plan.tokensBefore,
            }),
        );

        const projected = messagesForAgent(yield* readEntries, rootAgentId);
        expect(Arr.map(projected, (message) => message._tag)).toEqual(['compaction-summary', 'user-message']);
    }).pipe(Effect.provide(testLayer)),
);

it.effect('projects legacy forks through completed parent history plus child entries', () =>
    Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
            const log = yield* EventLog;
            const rootAgentId = yield* appendRoot();

            yield* log.append(
                LogEntryInputs['system-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    messages: [yield* systemMessage('root system')],
                    placement: 'leading',
                }),
            );
            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* userMessage('parent before fork'),
                }),
            );

            const forkAtSeq = lastSeq(yield* readEntries);
            const dispatchToolCallId = yield* toolCallId;
            const childAgentId = yield* agentId;

            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* userMessage('parent after fork'),
                }),
            );
            yield* log.append(
                LogEntryInputs.agent_started({
                    agentId: childAgentId,
                    parentAgentId: rootAgentId,
                    toolCallId: dispatchToolCallId,
                    mode: 'fork',
                    model,
                    tools: ['read'],
                    skill: null,
                    fork: { fromAgentId: rootAgentId, atSeq: forkAtSeq },
                    agentType: null,
                }),
            );
            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: childAgentId,
                    parentAgentId: rootAgentId,
                    toolCallId: dispatchToolCallId,
                    messageId: yield* messageId,
                    message: yield* userMessage('child prompt'),
                }),
            );

            return { childAgentId, entries: yield* readEntries };
        }).pipe(Effect.provide(testLayer));

        const projected = messagesForAgent(result.entries, result.childAgentId);

        expect(Arr.map(projected, (message) => message._tag)).toEqual(['system-message', 'user-message']);
        expect(projected[1]).toMatchObject({ message: { content: 'child prompt' } });
        expect(yield* encodeJsonText(projected)).not.toContain('parent before fork');
    }),
);

it.effect('configured fork history keeps recent completed turns and removes the invoking turn', () =>
    Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
            const log = yield* EventLog;
            const rootAgentId = yield* appendRoot();

            for (const [user, assistant] of [
                ['old user', 'old assistant'],
                ['recent user', 'recent assistant'],
            ] as const) {
                yield* log.append(
                    LogEntryInputs['user-message']({
                        agentId: rootAgentId,
                        parentAgentId: null,
                        toolCallId: null,
                        messageId: yield* messageId,
                        message: yield* userMessage(user),
                    }),
                );
                yield* log.append(
                    LogEntryInputs['assistant-message']({
                        agentId: rootAgentId,
                        parentAgentId: null,
                        toolCallId: null,
                        messageId: yield* messageId,
                        message: yield* assistantText(assistant),
                        finish: null,
                    }),
                );
            }

            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* userMessage('invoking user'),
                }),
            );

            const childAgentId = yield* agentId;
            const dispatchToolCallId = yield* toolCallId;
            yield* log.append(
                LogEntryInputs.agent_started({
                    agentId: childAgentId,
                    parentAgentId: rootAgentId,
                    toolCallId: dispatchToolCallId,
                    mode: 'fork',
                    model,
                    tools: [],
                    skill: null,
                    fork: { fromAgentId: rootAgentId, atSeq: lastSeq(yield* readEntries), history: 1 },
                    agentType: null,
                }),
            );
            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: childAgentId,
                    parentAgentId: rootAgentId,
                    toolCallId: dispatchToolCallId,
                    messageId: yield* messageId,
                    message: yield* userMessage('child prompt'),
                }),
            );

            return { childAgentId, entries: yield* readEntries };
        }).pipe(Effect.provide(testLayer));

        const projected = yield* encodeJsonText(messagesForAgent(result.entries, result.childAgentId));
        expect(projected).toContain('recent user');
        expect(projected).toContain('recent assistant');
        expect(projected).toContain('child prompt');
        expect(projected).not.toContain('old user');
        expect(projected).not.toContain('invoking user');
    }),
);

it.effect('projects compaction as a summary plus entries after the cut', () =>
    Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
            const log = yield* EventLog;
            const ids = yield* Ids;
            const rootAgentId = yield* appendRoot();

            yield* log.append(
                LogEntryInputs['system-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    messages: [yield* systemMessage('system survives')],
                    placement: 'leading',
                }),
            );
            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* userMessage('old user'),
                }),
            );

            const cutSeq = lastSeq(yield* readEntries);

            yield* log.append(
                LogEntryInputs.compaction({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    compactionId: yield* ids.makeCompactionId,
                    summary: 'summary of old history',
                    replacesThroughSeq: cutSeq,
                    tokensBefore: 123,
                }),
            );
            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* userMessage('new user'),
                }),
            );

            return { entries: yield* readEntries, rootAgentId };
        }).pipe(Effect.provide(testLayer));

        const projected = messagesForAgent(result.entries, result.rootAgentId);

        expect(Arr.map(projected, (message) => message._tag)).toEqual([
            'system-message',
            'compaction-summary',
            'user-message',
        ]);
        expect(projected[1]).toMatchObject({ summary: 'summary of old history' });
        expect(projected[2]).toMatchObject({ message: { content: 'new user' } });
    }),
);

it.effect('drops all pre-compaction messages except the leading system message', () =>
    Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
            const log = yield* EventLog;
            const ids = yield* Ids;
            const rootAgentId = yield* appendRoot();
            const oldToolCallId = yield* toolCallId;
            const newToolCallId = yield* toolCallId;

            yield* log.append(
                LogEntryInputs['system-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    messages: [yield* systemMessage('system survives compaction')],
                    placement: 'leading',
                }),
            );
            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* userMessage('old user should be hidden'),
                }),
            );
            yield* log.append(
                LogEntryInputs['assistant-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* assistantWithToolCalls([oldToolCallId]),
                    finish: null,
                }),
            );
            yield* log.append(
                LogEntryInputs['tool-result']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: oldToolCallId,
                    messageId: yield* messageId,
                    message: yield* toolMessage(oldToolCallId, 0),
                }),
            );

            const cutSeq = lastSeq(yield* readEntries);

            yield* log.append(
                LogEntryInputs.compaction({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    compactionId: yield* ids.makeCompactionId,
                    summary: 'compacted old user, assistant, and tool result',
                    replacesThroughSeq: cutSeq,
                    tokensBefore: 456,
                }),
            );
            yield* log.append(
                LogEntryInputs['user-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* userMessage('new user is visible'),
                }),
            );
            yield* log.append(
                LogEntryInputs['assistant-message']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: null,
                    messageId: yield* messageId,
                    message: yield* assistantWithToolCalls([newToolCallId]),
                    finish: null,
                }),
            );
            yield* log.append(
                LogEntryInputs['tool-result']({
                    agentId: rootAgentId,
                    parentAgentId: null,
                    toolCallId: newToolCallId,
                    messageId: yield* messageId,
                    message: yield* toolMessage(newToolCallId, 0),
                }),
            );

            return { entries: yield* readEntries, newToolCallId, rootAgentId };
        }).pipe(Effect.provide(testLayer));

        const projected = messagesForAgent(result.entries, result.rootAgentId);

        expect(Arr.map(projected, (message) => message._tag)).toEqual([
            'system-message',
            'compaction-summary',
            'user-message',
            'assistant-message',
            'tool-result',
        ]);
        expect(projected[0]).toMatchObject({
            messages: [{ content: 'system survives compaction' }],
        });
        expect(projected[1]).toMatchObject({
            summary: 'compacted old user, assistant, and tool result',
        });
        expect(projected[2]).toMatchObject({ message: { content: 'new user is visible' } });
        expect(projected[4]).toMatchObject({ toolCallId: result.newToolCallId });
        expect(Arr.filter(projected, Predicate.isTagged('user-message'))).not.toContainEqual(
            expect.objectContaining({
                message: expect.objectContaining({ content: 'old user should be hidden' }),
            }),
        );
    }),
);
