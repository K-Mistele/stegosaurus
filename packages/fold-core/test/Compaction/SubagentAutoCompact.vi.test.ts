import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
/**
 * Subagent auto-compaction tests (D11 x D21): the session-wide compaction policy applies to every
 * agent, but each agent compacts against its OWN projection with its own model - a dispatched
 * subagent's compaction entry lands under the child's envelope and never leaks into the parent's
 * context, and a FORK can compact history that includes the parent's folded range without touching
 * the parent's own view (global seq keeps the cut coherent - the worked D21 claim).
 */
import { expect, it } from '@effect/vitest';
import { Array as Arr, Option, Predicate, Effect, Schema, String as Str } from 'effect';

import {
    defineAgent,
    defineSubagent,
    messagesForAgent,
    Session,
    subagentTool,
    type AgentStartedLogEntry,
    type AutoCompactConfig,
    type CompactionLogEntry,
    type LogEntry,
} from '../../src/index';
import { claudeActiveModel, echoTool, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers';
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel';

const compactConfig: AutoCompactConfig = { enabled: true, contextWindow: 10_000, keepRecentTokens: 10 };

const hugeUsage = { inputTokens: 7_000 };

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const compactionEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<CompactionLogEntry> =>
    Arr.filter(entries, (entry): entry is CompactionLogEntry => Predicate.isTagged(entry, 'compaction'));

const subagentStarted = (entries: ReadonlyArray<LogEntry>): AgentStartedLogEntry => {
    const started = Arr.findFirst(
        entries,
        (entry): entry is AgentStartedLogEntry =>
            Predicate.isTagged(entry, 'agent_started') && entry.parentAgentId !== null,
    );

    if (Option.isNone(started)) throw new Error('expected a subagent agent_started entry');

    return started.value;
};

it.effect('a dispatched subagent compacts its own context; the parent projection never sees it', () =>
    Effect.gen(function* () {
        const researcherScripted = yield* scriptedModel(claudeActiveModel, [
            // Child turn 1 reports huge usage; child turn 2 opens with the summarization call.
            toolCallTurn([{ id: 'child-call-1', name: 'echo', params: { text: Str.repeat(100)('y') } }], hugeUsage),
            textTurn('## Goal\n- child summary', undefined),
            textTurn('child findings done', undefined),
        ]);

        const researcher = defineSubagent({
            name: 'researcher',
            description: 'Read-only exploration.',
            systemPrompt: 'You are a researcher.',
            model: researcherScripted.model,
            tools: [echoTool],
        });

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'provider-call-1',
                        name: 'subagent',
                        params: {
                            description: 'investigate',
                            prompt: 'investigate the flaky test',
                            agent: 'researcher',
                        },
                    },
                ],
                undefined,
            ),
            textTurn('root synthesis', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({
                model: rootScripted.model,
                systemPrompt: 'You are the root agent.',
                tools: [subagentTool([researcher], undefined)],
                // One session-wide policy (D11): the child compacts under it too, with its own model.
                autoCompact: compactConfig,
            }),
        });

        const finished = yield* session.send('dispatch the researcher');
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('completed');
        expect(finished.resultText).toBe('root synthesis');

        // Exactly one compaction: the child's, grouped under the dispatching call's envelope (D2).
        const child = subagentStarted(entries);
        const compactions = compactionEntries(entries);
        expect(compactions).toHaveLength(1);
        expect(compactions[0]?.agentId).toBe(child.agentId);
        expect(compactions[0]?.parentAgentId).toBe(child.parentAgentId);
        expect(compactions[0]?.toolCallId).toBe(child.toolCallId);

        // The child's post-compaction request: its summary stands in for the dispatch prompt, its own
        // leading prompt survives - and the summarization ran on the CHILD's model (its script).
        const childRequests = yield* researcherScripted.scripted.prompts;
        const childSummarize = yield* encodeJsonText(childRequests[1]);
        expect(childSummarize).toContain('[User]: investigate the flaky test');
        const childFinal = yield* encodeJsonText(childRequests[2]);
        expect(childFinal).toContain('<conversation-summary>');
        expect(childFinal).toContain('child summary');
        expect(childFinal).not.toContain('investigate the flaky test');
        expect(childFinal).toContain('You are a researcher.');

        // The parent's context is untouched: its own history intact, no summary anywhere.
        const rootRequests = yield* rootScripted.scripted.prompts;
        const rootFinal = yield* encodeJsonText(rootRequests[1]);
        expect(rootFinal).toContain('dispatch the researcher');
        expect(rootFinal).not.toContain('<conversation-summary>');

        // Projection read models agree per agent.
        expect(
            Arr.some(messagesForAgent(entries, session.rootAgentId), (m) =>
                Predicate.isTagged(m, 'compaction-summary'),
            ),
        ).toBe(false);
        expect(
            Arr.some(messagesForAgent(entries, child.agentId), (m) => Predicate.isTagged(m, 'compaction-summary')),
        ).toBe(true);

        expect(yield* researcherScripted.scripted.remainingTurns).toBe(0);
        expect(yield* rootScripted.scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('a fork compacts history including the parent folded range without touching the parent view', () =>
    Effect.gen(function* () {
        // The fork clones the root, so ONE script drives both agents, in strict causal order:
        // send 1 root turn, send 2 root turn (fork dispatch), fork turn 1 (huge usage), the fork's
        // history and split-turn-prefix summarization calls, fork turn 2 (result), then root close.
        const { model, scripted } = yield* scriptedModel(gptActiveModel, [
            textTurn(`parent knows: the launch code is 4242. ${Str.repeat(120)('k')}`, undefined),
            toolCallTurn(
                [
                    {
                        id: 'provider-call-1',
                        name: 'subagent',
                        params: { description: 'fork work', prompt: 'continue the analysis in a fork', fork: true },
                    },
                ],
                undefined,
            ),
            toolCallTurn([{ id: 'fork-call-1', name: 'echo', params: { text: Str.repeat(100)('z') } }], hugeUsage),
            textTurn('## Goal\n- fork summary', undefined),
            textTurn('fork turn prefix summary', undefined),
            textTurn('fork result ready', undefined),
            textTurn('root closing words', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({
                model,
                systemPrompt: 'You are the root agent.',
                tools: [echoTool, subagentTool([], undefined)],
                autoCompact: compactConfig,
            }),
        });

        yield* session.send('give me the parent context');
        const finished = yield* session.send('spawn a fork');
        const entries = yield* session.entries;

        expect(finished.outcome).toBe('completed');
        expect(finished.resultText).toBe('root closing words');

        // The fork's compaction cut reaches back past its fork point: replacesThroughSeq covers the
        // parent's folded history (everything at or below it stops rendering FOR THE FORK).
        const fork = subagentStarted(entries);
        expect(fork.mode).toBe('fork');
        const compactions = compactionEntries(entries);
        expect(compactions).toHaveLength(1);
        expect(compactions[0]?.agentId).toBe(fork.agentId);
        const atSeq = fork.fork?.atSeq;

        if (atSeq === undefined) throw new Error('expected fork provenance');
        expect(compactions[0]?.replacesThroughSeq).toBeGreaterThan(atSeq);

        const prompts = yield* scripted.prompts;

        // The fork's summarization saw the folded parent content - it IS part of what gets summarized.
        const forkSummarize = yield* encodeJsonText(prompts[3]);
        expect(forkSummarize).toContain('launch code is 4242');
        const forkPrefixSummarize = yield* encodeJsonText(prompts[4]);
        expect(forkPrefixSummarize).toContain('PREFIX of a turn that was too large to keep');

        // The fork's post-compaction request: summary in place, folded parent content gone.
        const forkFinal = yield* encodeJsonText(prompts[5]);
        expect(forkFinal).toContain('fork summary');
        expect(forkFinal).toContain('fork turn prefix summary');
        expect(forkFinal).not.toContain('launch code is 4242');

        // The parent's next request still carries its full own history: the fork's compaction is
        // agent-scoped, and global seq keeps the two views coherent over one flat log (D21).
        const rootClosing = yield* encodeJsonText(prompts[6]);
        expect(rootClosing).toContain('launch code is 4242');
        expect(rootClosing).not.toContain('<conversation-summary>');
        expect(
            Arr.some(messagesForAgent(entries, session.rootAgentId), (m) =>
                Predicate.isTagged(m, 'compaction-summary'),
            ),
        ).toBe(false);

        expect(yield* scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
