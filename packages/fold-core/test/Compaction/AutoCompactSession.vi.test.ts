import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
/**
 * Facade-level auto-compaction tests (D11): sessions configured with `autoCompact` compact at the
 * top-of-turn threshold and on reactive provider overflow, write durable `compaction` entries, and
 * keep running - all driven through `Session.open` with scripted models, exactly as
 * SDK callers configure it. The summarization call runs on the session's own scripted model, so each
 * script interleaves the summarizer's response at the position the loop calls it.
 *
 * Key claims covered: only messages after the cut reach the model (the summary stands in for the
 * rest), the session keeps running across and after compaction, pre-compaction configuration
 * (tools, model, leading prompt) survives, stale pre-compaction usage never re-triggers, incremental
 * compaction threads the previous summary, overflow recovery retries exactly once, summarizer
 * failures degrade to a durable error note, and a resumed log projects the compacted history.
 */
import { expect, it } from '@effect/vitest';
import { Array as Arr, Data, Predicate, Context, Effect, Layer, Schema, String as Str } from 'effect';

import {
    defineAgent,
    layerInMemoryEventLog,
    messagesForAgent,
    Session,
    runtimeForAgent,
    EventLog,
    type AutoCompactConfig,
    type CodexReasoningSetting,
    type CompactionArchiveAccessService,
    type CompactionLogEntry,
    type ErrorLogEntry,
    type EventLogService,
    type LogEntry,
    type ModelCatalogEntry,
    type UserMessageLogEntry,
} from '../../src/index';
import { failureTurn, textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel';
import { echoTool, gptActiveModel, scriptedModel } from './../Api/ApiTestHelpers';

const CodexReasoning = Data.taggedEnum<CodexReasoningSetting>();

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const codexActiveModel = {
    ...gptActiveModel,
    providerId: 'codex',
    providerKind: 'codex' as const,
    requestedReasoningLevel: 'off' as const,
    reasoning: CodexReasoning.disabled(),
};

/**
 * Small-window config for deterministic triggering: usable = 10000 - 2500 - 1250 = 6250 tokens, so
 * a scripted response reporting ~7000 input tokens trips the threshold, and a 10-token keep budget
 * makes the cut land after the first message or two of tiny test conversations.
 */
const compactConfig: AutoCompactConfig = { enabled: true, contextWindow: 10_000, keepRecentTokens: 10 };

/** Usage that exceeds the configured usable budget on the next check. */
const hugeUsage = { inputTokens: 7_000 };

const compactionEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<CompactionLogEntry> =>
    Arr.filter(entries, (entry): entry is CompactionLogEntry => Predicate.isTagged(entry, 'compaction'));

const errorEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<ErrorLogEntry> =>
    Arr.filter(entries, (entry): entry is ErrorLogEntry => Predicate.isTagged(entry, 'error'));

const userEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<UserMessageLogEntry> =>
    Arr.filter(entries, (entry): entry is UserMessageLogEntry => Predicate.isTagged(entry, 'user-message'));

it.effect('compacts mid-run at the threshold and keeps running; config from before the cut survives', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            // Turn 1: a tool call whose reported usage exceeds the budget - the NEXT turn compacts.
            toolCallTurn([{ id: 'provider-call-1', name: 'echo', params: { text: Str.repeat(100)('x') } }], hugeUsage),
            // Turn 2 opens with the summarization call, then the real request continues the run.
            textTurn('## Goal\n- compaction demo summary', undefined),
            textTurn('all done', undefined),
        ]);

        const archiveAccess: CompactionArchiveAccessService = {
            instructions: ({ agentId }) => Effect.succeed(`<archive-access>agent=${agentId}</archive-access>`),
        };

        const session = yield* Session.open({
            agent: defineAgent({
                model,
                systemPrompt: 'You are the compaction demo agent.',
                tools: [echoTool],
                autoCompact: compactConfig,
            }),
            compactionArchiveAccess: archiveAccess,
        });

        const finished = yield* session.send('use echo with the big payload');
        const entries = yield* session.entries;

        // The run survived the mid-run compaction and completed normally.
        expect(finished.outcome).toBe('completed');
        expect(finished.resultText).toBe('all done');

        // Exactly one durable compaction entry, under the root run's envelope, cutting through the
        // user message (the tool exchange is the kept tail) and recording the triggering usage.
        const compactions = compactionEntries(entries);
        expect(compactions).toHaveLength(1);
        const compaction = compactions[0];

        if (compaction === undefined) throw new Error('expected a compaction entry');
        expect(compaction.agentId).toBe(session.rootAgentId);
        expect(compaction.parentAgentId).toBeNull();
        expect(compaction.toolCallId).toBeNull();
        expect(compaction.summary).toContain('compaction demo summary');
        expect(compaction.postCompactionInstructions).toBe(
            `<archive-access>agent=${session.rootAgentId}</archive-access>`,
        );
        expect(compaction.tokensBefore).toBe(7_005);
        expect(compaction.replacesThroughSeq).toBe(userEntries(entries)[0]?.seq);

        const requests = yield* scripted.requests;
        expect(requests).toHaveLength(3);

        // The summarization request: no tools advertised, pi's system prompt and default instruction,
        // and the replaced history serialized inside <conversation>.
        const summarizeRequest = yield* encodeJsonText(requests[1]?.prompt);
        expect(requests[1]?.toolNames).toEqual([]);
        expect(requests[1]?.openAiConfig?.max_output_tokens).toBe(8_192);
        expect(summarizeRequest).toContain('context summarization assistant');
        expect(summarizeRequest).toContain('PREFIX of a turn that was too large to keep');
        expect(summarizeRequest).toContain('[User]: use echo with the big payload');
        expect(summarizeRequest).not.toContain('<archive-access>');

        // The post-compaction request: the summary stands in for the replaced user message, the kept
        // tool exchange is still there verbatim, and the epoch configuration is untouched - same
        // leading prompt, same advertised tools.
        const finalRequest = yield* encodeJsonText(requests[2]?.prompt);
        expect(finalRequest).toContain('<conversation-summary>');
        expect(finalRequest).toContain('compaction demo summary');
        expect(finalRequest).toContain(`<archive-access>agent=${session.rootAgentId}</archive-access>`);
        expect(finalRequest).not.toContain('use echo with the big payload');
        expect(finalRequest).toContain(Str.repeat(100)('x'));
        expect(finalRequest).toContain('You are the compaction demo agent.');
        expect(requests[2]?.toolNames).toEqual(['echo']);

        // Projection read models agree: the summary leads the conversation, and the runtime fold
        // (model, tools, reasoning) is untouched by the cut - those facts predate the compaction.
        const projected = messagesForAgent(entries, session.rootAgentId);
        expect(projected[0]?._tag).toBe('system-message');
        expect(projected[1]?._tag).toBe('compaction-summary');
        const runtime = runtimeForAgent(entries, session.rootAgentId);
        expect(runtime.activeModel?.modelId).toBe('gpt-scripted');
        expect(runtime.activeTools).toEqual(['echo']);

        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect(
    'compacts across sends and incrementally: only the newest summary and post-cut messages reach the model',
    () =>
        Effect.gen(function* () {
            const { model, scripted } = yield* scriptedModel(gptActiveModel, [
                // Send 1: a long answer reporting huge usage - send 2 opens by compacting.
                textTurn(`noted. ${Str.repeat(120)('p')}`, hugeUsage),
                textTurn('## Goal\n- sky summary', undefined),
                // Send 2's real answer is long and huge again - send 3 compacts incrementally.
                textTurn(`answer two. ${Str.repeat(120)('q')}`, { inputTokens: 7_200 }),
                textTurn('## Goal\n- combined history v2', undefined),
                textTurn('second turn prefix context', undefined),
                textTurn('third answer', undefined),
            ]);

            const session = yield* Session.open({
                agent: defineAgent({ model, systemPrompt: 'Assistant.', autoCompact: compactConfig }),
            });

            yield* session.send('first topic: the sky is teal today');
            yield* session.send('second topic please');
            const third = yield* session.send('third topic');
            const entries = yield* session.entries;

            expect(third.outcome).toBe('completed');
            expect(third.resultText).toBe('third answer');

            const compactions = compactionEntries(entries);
            expect(compactions).toHaveLength(2);

            const requests = yield* scripted.requests;
            expect(requests).toHaveLength(6);

            // First summarization: no previous summary - the initial instruction.
            const firstSummarize = yield* encodeJsonText(requests[1]?.prompt);
            expect(firstSummarize).toContain('[User]: first topic: the sky is teal today');
            expect(firstSummarize).not.toContain('<previous-summary>');

            // Send 2's request: summary one stands in for the first topic.
            const secondSend = yield* encodeJsonText(requests[2]?.prompt);
            expect(secondSend).toContain('sky summary');
            expect(secondSend).not.toContain('sky is teal');
            expect(secondSend).toContain('second topic please');

            // Second summarization: incremental - the previous summary rides in <previous-summary> and
            // the update instruction replaces the initial one.
            const secondSummarize = yield* encodeJsonText(requests[3]?.prompt);
            expect(secondSummarize).toContain('<previous-summary>');
            expect(secondSummarize).toContain('sky summary');
            expect(secondSummarize).toContain('NEW conversation messages');

            // Send 3's request: ONLY the newest summary renders (latest compaction wins); the previously
            // kept-then-summarized messages are gone; the new kept tail and the new message are present.
            const secondPrefixSummarize = yield* encodeJsonText(requests[4]?.prompt);
            expect(secondPrefixSummarize).toContain('second topic please');
            expect(secondPrefixSummarize).toContain('PREFIX of a turn that was too large to keep');

            const thirdSend = yield* encodeJsonText(requests[5]?.prompt);
            expect(thirdSend).toContain('combined history v2');
            expect(thirdSend).toContain('second turn prefix context');
            expect(thirdSend).not.toContain('sky summary');
            expect(thirdSend).not.toContain('second topic please');
            expect(thirdSend).toContain('answer two.');
            expect(thirdSend).toContain('third topic');

            expect(yield* scripted.remainingTurns).toBe(0);
        }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('stale pre-compaction usage never re-triggers: no second compaction without a fresh response', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`big reply ${Str.repeat(120)('r')}`, hugeUsage),
            // Send 2: compaction succeeds, then the model call itself fails (NOT an overflow) - the run
            // ends error with no post-compaction usage on record.
            textTurn('## Goal\n- first summary', undefined),
            failureTurn('boom'),
            // Send 3 must NOT compact again: the only reported usage predates the compaction.
            textTurn('recovered fine', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model, autoCompact: compactConfig }),
        });

        yield* session.send('topic one anchor text');
        const second = yield* session.send('topic two');
        const third = yield* session.send('topic three');
        const entries = yield* session.entries;

        expect(second.outcome).toBe('error');
        expect(third.outcome).toBe('completed');
        expect(third.resultText).toBe('recovered fine');

        expect(compactionEntries(entries)).toHaveLength(1);

        // Send 3 ran against the compacted projection without compacting again.
        const requests = yield* scripted.requests;
        const thirdSend = yield* encodeJsonText(requests[3]?.prompt);
        expect(thirdSend).toContain('first summary');
        expect(thirdSend).not.toContain('topic one anchor text');

        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('enabled: false disables automatic compaction while leaving explicit compaction available', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn('first', hugeUsage),
            textTurn('second', undefined),
            textTurn('manual summary', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model, autoCompact: { enabled: false } }),
        });

        yield* session.send('one: the anchor phrase');
        const finished = yield* session.send('two');
        expect(finished.outcome).toBe('completed');
        expect(compactionEntries(yield* session.entries)).toHaveLength(0);

        const compacted = yield* session.compact();
        expect(compacted?.summary).toBe('manual summary');
        expect(compactionEntries(yield* session.entries)).toHaveLength(1);

        const requests = yield* scripted.requests;
        expect(yield* encodeJsonText(requests[1]?.prompt)).toContain('one: the anchor phrase');
        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('automatic compaction is enabled when the definition omits autoCompact', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`first ${Str.repeat(100_000)('x')}`, { inputTokens: 120_000 }),
            textTurn('default policy summary', undefined),
            textTurn('second', undefined),
        ]);

        const session = yield* Session.open({ agent: defineAgent({ model }) });

        yield* session.send('one');
        const finished = yield* session.send('two');

        expect(finished.outcome).toBe('completed');
        expect(compactionEntries(yield* session.entries)).toHaveLength(1);
        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('manual facade compaction delegates through the provisioned root runtime', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`first answer ${Str.repeat(120)('x')}`, undefined),
            textTurn('## Goal\n- manual compaction summary', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model, autoCompact: compactConfig }),
        });

        yield* session.send('manual compact anchor');
        const compacted = yield* session.compact();
        const entries = yield* session.entries;

        expect(compacted).not.toBeNull();
        expect(compactionEntries(entries)).toHaveLength(1);
        expect(compacted?.agentId).toBe(session.rootAgentId);
        expect(compacted?.parentAgentId).toBeNull();
        expect(compacted?.toolCallId).toBeNull();
        expect(compacted?.prompt).toContain('structured context checkpoint summary');
        expect(compacted?.summary).toContain('manual compaction summary');

        const requests = yield* scripted.requests;
        expect(requests).toHaveLength(2);
        expect(yield* encodeJsonText(requests[1]?.prompt)).toContain('manual compact anchor');
        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('manual compaction appends host guidance to the standard instruction without a follow-up turn', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn('first answer', undefined),
            textTurn('guided summary', undefined),
        ]);

        const session = yield* Session.open({ agent: defineAgent({ model }) });

        yield* session.send('preserve the migration investigation');
        const compacted = yield* session.compact({ additionalInstructions: 'Keep the failed migration command.' });

        expect(compacted?.prompt).toContain('Additional user guidance for this compaction:');
        expect(
            Predicate.isString(compacted?.prompt) &&
                Str.endsWith('Keep the failed migration command.')(compacted.prompt),
        ).toBe(true);
        const requests = yield* scripted.requests;
        expect(yield* encodeJsonText(requests[1]?.prompt)).toContain('Keep the failed migration command.');
        expect(requests).toHaveLength(2);
        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('Codex compaction omits the unsupported max output token override', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(codexActiveModel, [
            textTurn('first answer', undefined),
            textTurn('Codex summary', undefined),
        ]);

        const session = yield* Session.open({ agent: defineAgent({ model }) });

        yield* session.send('preserve the investigation');
        yield* session.compact();

        const requests = yield* scripted.requests;
        expect(requests[1]?.openAiConfig?.max_output_tokens).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('split-turn compaction separately summarizes a coherent discarded prefix and keeps its suffix', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            toolCallTurn([{ id: 'provider-call-split', name: 'echo', params: { text: 'prefix payload' } }], undefined),
            textTurn(`kept suffix ${Str.repeat(160)('z')}`, undefined),
            textTurn('original request and early tool progress', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model, tools: [echoTool], autoCompact: compactConfig }),
        });

        yield* session.send('perform the oversized multi-message turn');
        const compacted = yield* session.compact();

        expect(compacted?.summary).toBe(
            'No prior history.\n\n---\n\n**Turn Context (split turn):**\n\noriginal request and early tool progress',
        );
        const requests = yield* scripted.requests;
        expect(requests).toHaveLength(3);
        const prefixRequest = yield* encodeJsonText(requests[2]?.prompt);
        expect(prefixRequest).toContain('perform the oversized multi-message turn');
        expect(prefixRequest).toContain('echo');
        expect(prefixRequest).toContain('prefix payload');
        expect(prefixRequest).toContain('PREFIX of a turn that was too large to keep');
        expect(prefixRequest).not.toContain('[Assistant]: kept suffix');
        expect(requests[2]?.openAiConfig?.max_output_tokens).toBe(8_192);

        const projected = messagesForAgent(yield* session.entries, session.rootAgentId);
        expect(Arr.map(projected, (message) => message._tag)).toEqual(['compaction-summary', 'assistant-message']);
        expect(yield* encodeJsonText(projected[1])).toContain('kept suffix');
        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('a configured compactionPrompt replaces the default instruction template', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`long answer ${Str.repeat(120)('w')}`, hugeUsage),
            textTurn('CUSTOM CHECKPOINT: compact haiku', undefined),
            textTurn('continuing', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({
                model,
                autoCompact: { ...compactConfig, compactionPrompt: 'Reply with a CUSTOM CHECKPOINT of the work.' },
            }),
        });

        yield* session.send('start topic');
        const finished = yield* session.send(`next topic ${Str.repeat(80)('n')}`);
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('completed');
        expect(compactionEntries(entries)[0]?.summary).toContain('CUSTOM CHECKPOINT');
        expect(compactionEntries(entries)[0]?.prompt).toBe('Reply with a CUSTOM CHECKPOINT of the work.');

        const summarizeRequest = yield* encodeJsonText((yield* scripted.requests)[1]?.prompt);
        expect(summarizeRequest).toContain('Reply with a CUSTOM CHECKPOINT of the work.');
        expect(summarizeRequest).not.toContain('structured context checkpoint summary');
        // The framing around the instruction is fixed: the transcript still rides in <conversation>.
        expect(summarizeRequest).toContain('<conversation>');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('a summarizer failure degrades to a durable error note; the run proceeds uncompacted', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`anchor answer ${Str.repeat(120)('s')}`, hugeUsage),
            // The summarization call itself fails...
            failureTurn('summarizer exploded'),
            // ...and the turn proceeds against the full, uncompacted history.
            textTurn('answered anyway', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model, autoCompact: compactConfig }),
        });

        yield* session.send('anchor question one');
        const finished = yield* session.send('question two');
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('completed');
        expect(finished.resultText).toBe('answered anyway');

        expect(compactionEntries(entries)).toHaveLength(0);
        const errors = errorEntries(entries);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.errorType).toBe('compaction');
        expect(errors[0]?.message).toContain('summarizer exploded');

        // Uncompacted means the full history reached the model.
        const finalRequest = yield* encodeJsonText((yield* scripted.requests)[2]?.prompt);
        expect(finalRequest).toContain('anchor question one');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('reactive overflow: compact and retry the turn once, then the run completes cleanly', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`anchor reply ${Str.repeat(120)('t')}`, undefined),
            // Send 2's first attempt overflows; the loop compacts and restarts the turn.
            failureTurn('request failed: context_length_exceeded'),
            textTurn('## Goal\n- overflow summary', undefined),
            textTurn('recovered answer', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model, autoCompact: compactConfig }),
        });

        yield* session.send('the launch code is 4242');
        const finished = yield* session.send('now do the follow-up');
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('completed');
        expect(finished.resultText).toBe('recovered answer');

        expect(compactionEntries(entries)).toHaveLength(1);
        // A recovered overflow is transient: no durable error entries anywhere.
        expect(errorEntries(entries)).toHaveLength(0);

        const retriedRequest = yield* encodeJsonText((yield* scripted.requests)[3]?.prompt);
        expect(retriedRequest).toContain('overflow summary');
        expect(retriedRequest).not.toContain('launch code is 4242');
        expect(retriedRequest).toContain('now do the follow-up');

        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('overflow recovery runs once per run: a second overflow becomes the durable error outcome', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`anchor ${Str.repeat(120)('u')}`, undefined),
            failureTurn('context_length_exceeded'),
            textTurn('## Goal\n- attempt summary', undefined),
            failureTurn('context_length_exceeded again'),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model, autoCompact: compactConfig }),
        });

        yield* session.send('seed');
        const finished = yield* session.send('go');
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('error');
        expect(compactionEntries(entries)).toHaveLength(1);

        const errors = errorEntries(entries);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.errorType).toBe('model');
        expect(errors[0]?.message).toContain('context_length_exceeded again');

        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

/** A catalog row for the scripted model with deterministic context and output limits. */
const scriptedCatalogEntry = (contextWindow: number, maxOutputTokens = 32_000): ModelCatalogEntry => ({
    providerId: 'scripted-openai',
    modelId: 'gpt-scripted',
    name: null,
    contextWindow,
    maxInputTokens: null,
    maxOutputTokens,
    reasoning: false,
    reasoningEfforts: null,
    vision: false,
    toolCall: true,
    pricing: null,
});

it.effect('a session-provided catalog supplies the compaction context window (no explicit override)', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            // Send 1 reports usage over the CATALOG window's usable budget - send 2 opens by compacting.
            textTurn(`noted. ${Str.repeat(120)('c')}`, hugeUsage),
            textTurn('## Goal\n- catalog-window summary', undefined),
            textTurn('post-catalog-compaction answer', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({
                model,
                // No autoCompact.contextWindow: the window must come from the session catalog (10k ->
                // usable 6250, and hugeUsage reports 7005).
                autoCompact: { enabled: true, keepRecentTokens: 10 },
            }),
            catalog: [scriptedCatalogEntry(10_000, 4_000)],
        });

        yield* session.send('catalog topic one anchor');
        const finished = yield* session.send('catalog topic two');
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('completed');
        expect(finished.resultText).toBe('post-catalog-compaction answer');
        expect(compactionEntries(entries)).toHaveLength(1);

        // The compacted request proves the catalog window drove a real cut.
        const requests = yield* scripted.requests;
        expect(requests[1]?.openAiConfig?.max_output_tokens).toBe(4_000);
        const secondSend = yield* encodeJsonText(requests[2]?.prompt);
        expect(secondSend).toContain('catalog-window summary');
        expect(secondSend).not.toContain('catalog topic one anchor');

        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('a Codex model uses the app context window instead of the public API catalog window', () =>
    Effect.gen(function* () {
        const astraModel = { ...codexActiveModel, modelId: 'gpt-6-astra' };

        const { model, scripted } = yield* scriptedModel(astraModel, [
            textTurn(`noted ${Str.repeat(120)('a')}`, { inputTokens: 240_000 }),
            textTurn('## Goal\n- codex-window summary', undefined),
            textTurn('post-codex-compaction answer', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model, autoCompact: { enabled: true, keepRecentTokens: 10 } }),
            catalog: [
                {
                    ...scriptedCatalogEntry(1_050_000),
                    providerId: 'openai',
                    modelId: 'gpt-6-astra',
                },
            ],
        });

        yield* session.send('codex topic one');
        const finished = yield* session.send('codex topic two');

        expect(finished.resultText).toBe('post-codex-compaction answer');
        expect(compactionEntries(yield* session.entries)).toHaveLength(1);
        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('GPT-6.1 Sol, GPT-6 Sol, and Luna compact against the 272k Codex window instead of the public catalog', () =>
    Effect.gen(function* () {
        for (const modelId of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
            const activeModel = { ...codexActiveModel, modelId };

            const { model, scripted } = yield* scriptedModel(activeModel, [
                textTurn(`noted ${Str.repeat(120)('a')}`, { inputTokens: 224_000 }),
                textTurn(`## Goal\n- ${modelId} summary`, undefined),
                textTurn(`${modelId} answer`, undefined),
            ]);

            const session = yield* Session.open({
                agent: defineAgent({ model, autoCompact: { enabled: true, keepRecentTokens: 10 } }),
                catalog: [
                    {
                        ...scriptedCatalogEntry(1_050_000),
                        providerId: 'openai',
                        modelId,
                    },
                ],
            });

            yield* session.send(`${modelId} topic one`);
            const finished = yield* session.send(`${modelId} topic two`);

            expect(finished.resultText).toBe(`${modelId} answer`);
            expect(compactionEntries(yield* session.entries)).toHaveLength(1);
            expect(yield* scripted.remainingTurns).toBe(0);
        }
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('an explicit autoCompact.contextWindow beats the catalog entry', () =>
    Effect.gen(function* () {
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`noted. ${Str.repeat(120)('e')}`, hugeUsage),
            textTurn('## Goal\n- override summary', undefined),
            textTurn('override answer', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({
                model,
                // The explicit 10k window compacts on 7005 reported tokens; the catalog's 1M window
                // would not (usable ~951k) - so a compaction proves the override won.
                autoCompact: { enabled: true, contextWindow: 10_000, keepRecentTokens: 10 },
            }),
            catalog: [scriptedCatalogEntry(1_000_000)],
        });

        yield* session.send('override topic one');
        const finished = yield* session.send('override topic two');
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('completed');
        expect(compactionEntries(entries)).toHaveLength(1);
        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('a resumed log projects the compacted history: summary plus post-cut messages only', () =>
    Effect.gen(function* () {
        const logContext = yield* Layer.build(layerInMemoryEventLog);
        const sharedLog: EventLogService = Context.get(logContext, EventLog);

        // Session A compacts, answers, and closes.
        yield* Effect.scoped(
            Effect.gen(function* () {
                const { model } = yield* scriptedModel(gptActiveModel, [
                    textTurn(`noted ${Str.repeat(120)('v')}`, hugeUsage),
                    textTurn('## Goal\n- durable summary', undefined),
                    textTurn('answer two', undefined),
                ]);

                const session = yield* Session.open({
                    agent: defineAgent({ model, systemPrompt: 'Assistant.', autoCompact: compactConfig }),
                }).pipe(Effect.provideService(EventLog, sharedLog));

                yield* session.send('the secret phrase is xyzzy');
                const finished = yield* session.send('next');
                expect(finished.outcome).toBe('completed');
            }),
        );

        // Session B adopts the same log with the same configuration: replay rebuilds the compacted
        // projection - the durable summary and the kept tail, not the replaced history.
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [textTurn('resumed answer', undefined)]);

        const session = yield* Session.open({
            agent: defineAgent({ model, systemPrompt: 'Assistant.', autoCompact: compactConfig }),
        }).pipe(Effect.provideService(EventLog, sharedLog));

        const finished = yield* session.send('continue');
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('completed');
        expect(finished.resultText).toBe('resumed answer');
        expect(compactionEntries(entries)).toHaveLength(1);

        const resumedRequest = yield* encodeJsonText((yield* scripted.prompts)[0]);
        expect(resumedRequest).toContain('durable summary');
        expect(resumedRequest).toContain('answer two');
        expect(resumedRequest).toContain('continue');
        expect(resumedRequest).not.toContain('secret phrase is xyzzy');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
