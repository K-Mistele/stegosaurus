import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
/**
 * Engine tests for the REAL subagent tool wire (D21): the model dispatches and resumes subagents by
 * calling the `subagent` tool with its flat wire parameters - no test-only drive tool in the loop - so
 * these prove the whole path the SDK ships: wire params -> parseSubagentCommand -> subagent operations ->
 * rendered durable result. The resume turn's agent_id is only known after the dispatch, so the root's
 * script is extended between sends (`pushTurns`). Malformed commands (no selector, garbage agent_id,
 * unknown agent_id) come back as instructive tool failures the model can correct from.
 */
import { expect, it } from '@effect/vitest';
import { Array as Arr, Predicate, Context, Effect, Layer, Schema, Option, String as Str } from 'effect';

import {
    AgentId,
    defineAgent,
    defineSubagent,
    EventLog,
    layerInMemoryEventLog,
    shortAgentId,
    Session,
    subagentTool,
    ToolCallId,
    ToolResultText,
    LogEntryInputs,
    type UserMessageLogEntry,
} from '../../src/index';
import { claudeActiveModel, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers';
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel';
import { renderedDriveResult, subagentStartedEntries } from './DriveHarness';

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect('presents the rendered subagent result to the parent model as plain text', () =>
    Effect.gen(function* () {
        const researcherScripted = yield* scriptedModel(claudeActiveModel, [textTurn('verified findings', undefined)]);

        const researcher = defineSubagent({
            name: 'researcher',
            description: 'explores',
            model: researcherScripted.model,
        });

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'provider-call-1',
                        name: 'subagent',
                        params: { description: 'verify behavior', prompt: 'inspect it', agent: 'researcher' },
                    },
                ],
                undefined,
            ),
            textTurn('parent synthesis', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher], undefined)] }),
        });

        yield* session.send('go');

        const entries = yield* session.entries;

        const durableEntry = Option.getOrUndefined(
            Arr.findFirst(entries, (entry) => Predicate.isTagged(entry, 'tool-result')),
        );

        if (!Predicate.isTagged(durableEntry, 'tool-result')) throw new Error('expected a durable subagent result');
        const durablePart = durableEntry.message.content[0];

        if (durablePart?.type !== 'tool-result' || !Schema.is(ToolResultText)(durablePart.result)) {
            throw new Error('expected the durable tagged subagent text');
        }

        const expected = durablePart.result.text;
        const parentPrompts = yield* rootScripted.scripted.prompts;
        const followUpPrompt = parentPrompts[1];

        if (followUpPrompt === undefined) throw new Error('expected the parent follow-up prompt');

        const toolResult = Option.getOrUndefined(
            Arr.findFirst(
                Arr.flatMap(followUpPrompt.content, (message) => (message.role === 'tool' ? message.content : [])),
                (part) => part.type === 'tool-result',
            ),
        );

        if (toolResult?.type !== 'tool-result') throw new Error('expected a subagent tool result');

        expect(toolResult.result).toBe(expected);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('the model resumes a subagent through the tool wire by its SHORT id: full context, new call', () =>
    Effect.gen(function* () {
        const researcherScripted = yield* scriptedModel(claudeActiveModel, [
            textTurn('first findings', undefined),
            textTurn('resumed findings', undefined),
        ]);

        const researcher = defineSubagent({
            name: 'researcher',
            description: 'explores',
            systemPrompt: 'You are a researcher.',
            model: researcherScripted.model,
        });

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'provider-call-1',
                        name: 'subagent',
                        params: {
                            description: 'map module',
                            prompt: 'map the module',
                            agent: 'researcher',
                            agent_id: '',
                            fork: false,
                        },
                    },
                ],
                undefined,
            ),
            textTurn('synthesized', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({
                model: rootScripted.model,
                systemPrompt: 'root',
                tools: [subagentTool([researcher], undefined)],
            }),
        });

        const firstFinished = yield* session.send('go');
        expect(firstFinished.outcome).toBe('completed');

        const afterDispatch = yield* session.entries;
        const started = subagentStartedEntries(afterDispatch)[0];

        if (started === undefined) throw new Error('expected the dispatched subagent to have started');

        // The resume turn embeds the SHORT agent_id, exactly as a model reads it off the first result's
        // `agent_id:` line - the engine resolves the unique prefix back to the full id.
        yield* rootScripted.scripted.pushTurns([
            toolCallTurn(
                [
                    {
                        id: 'provider-call-2',
                        name: 'subagent',
                        params: {
                            description: 'follow up',
                            prompt: 'keep going',
                            agent: '',
                            agent_id: shortAgentId(started.agentId),
                            fork: false,
                        },
                    },
                ],
                undefined,
            ),
            textTurn('synthesized again', undefined),
        ]);

        const secondFinished = yield* session.send('continue with the researcher');
        expect(secondFinished.outcome).toBe('completed');

        const entries = yield* session.entries;

        // Resume through the wire wrote no second agent_started and grouped rows under the resuming call.
        expect(subagentStartedEntries(entries)).toHaveLength(1);

        const researcherUserMessages = Arr.filter(
            entries,
            (entry): entry is UserMessageLogEntry =>
                Predicate.isTagged(entry, 'user-message') && entry.agentId === started.agentId,
        );

        expect(researcherUserMessages).toHaveLength(2);
        expect(researcherUserMessages[1]?.toolCallId).not.toBeNull();
        expect(researcherUserMessages[1]?.toolCallId).not.toBe(researcherUserMessages[0]?.toolCallId);

        // The resumed model call saw the full prior context plus the wire prompt.
        const prompts = yield* researcherScripted.scripted.prompts;
        const resumedPrompt = yield* encodeJsonText(prompts[1]);
        expect(resumedPrompt).toContain('map the module');
        expect(resumedPrompt).toContain('first findings');
        expect(resumedPrompt).toContain('keep going');

        // The rendered resume result reports the short id and per-run/lifetime turn counts.
        const rendered = yield* renderedDriveResult(entries, 1);
        expect(rendered).toContain(`agent_id: ${shortAgentId(started.agentId)}`);
        expect(rendered).toContain('turns: 1 this run (2 total)');
        expect(rendered).toContain('resumed findings');

        expect(yield* rootScripted.scripted.remainingTurns).toBe(0);
        expect(yield* researcherScripted.scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('the public fork wire persists completed-history selection', () =>
    Effect.gen(function* () {
        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'provider-call-1',
                        name: 'subagent',
                        params: {
                            description: 'inspect context',
                            prompt: 'inspect the completed context',
                            agent: '',
                            agent_id: '',
                            fork: true,
                            skill: '',
                        },
                    },
                ],
                undefined,
            ),
            textTurn('fork findings', undefined),
            textTurn('root complete', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({
                model: rootScripted.model,
                systemPrompt: 'root',
                tools: [subagentTool([], undefined)],
            }),
        });

        const finished = yield* session.send('parent request');
        expect(finished.outcome).toBe('completed');

        const started = subagentStartedEntries(yield* session.entries)[0];

        if (started === undefined) throw new Error('expected the fork to have started');
        expect(started.fork?.history).toBe('all');

        const prompts = yield* rootScripted.scripted.prompts;
        const forkRequest = prompts[1];

        if (forkRequest === undefined) throw new Error('expected the fork request');
        const forkRequestJson = yield* encodeJsonText(forkRequest.content);
        expect(forkRequestJson).toContain('inspect the completed context');
        expect(forkRequestJson).not.toContain('provider-call-1');
        expect(forkRequestJson).not.toContain('parent request');
        expect(yield* rootScripted.scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('malformed wire commands come back as instructive tool failures the model can correct from', () =>
    Effect.gen(function* () {
        const researcherScripted = yield* scriptedModel(claudeActiveModel, []);

        const researcher = defineSubagent({
            name: 'researcher',
            description: 'explores',
            model: researcherScripted.model,
        });

        // Three bad calls in sequence: no selector, a garbage id, and a well-formed id no agent ever had.
        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'provider-call-1',
                        name: 'subagent',
                        params: {
                            description: 'oops',
                            prompt: 'do something',
                            agent: '',
                            agent_id: '',
                            fork: false,
                        },
                    },
                ],
                undefined,
            ),
            toolCallTurn(
                [
                    {
                        id: 'provider-call-2',
                        name: 'subagent',
                        params: { description: 'oops', prompt: 'do something', agent_id: 'not-an-id' },
                    },
                ],
                undefined,
            ),
            toolCallTurn(
                [
                    {
                        id: 'provider-call-3',
                        name: 'subagent',
                        params: {
                            description: 'oops',
                            prompt: 'do something',
                            agent_id: 'agent_aaaaaaaaaaaaaaaaaaaaaaaa',
                        },
                    },
                ],
                undefined,
            ),
            textTurn('gave up gracefully', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher], undefined)] }),
        });

        const finished = yield* session.send('go');
        expect(finished.outcome).toBe('completed');

        const entries = yield* session.entries;
        expect(subagentStartedEntries(entries)).toHaveLength(0); // nothing ever dispatched

        expect(yield* renderedDriveResult(entries, 0)).toContain('Provide exactly one of agent');
        expect(yield* renderedDriveResult(entries, 1)).toContain('is not a valid subagent id');
        expect(yield* renderedDriveResult(entries, 2)).toContain('No subagent with agent_id');

        expect(yield* rootScripted.scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('an ambiguous short agent_id comes back as an instructive failure naming the candidate short ids', () =>
    Effect.gen(function* () {
        // A shared log the test can seed directly: two started agents whose cuid segments share the
        // 6-character prefix "abcdef" but diverge inside the 8-character short id, so the short ref
        // "agent_abcdef" matches both and the candidates the failure names are distinguishable.
        const logContext = yield* Layer.build(layerInMemoryEventLog);
        const sharedLog = Context.get(logContext, EventLog);

        const researcherScripted = yield* scriptedModel(claudeActiveModel, []);

        const researcher = defineSubagent({
            name: 'researcher',
            description: 'explores',
            model: researcherScripted.model,
        });

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'provider-call-1',
                        name: 'subagent',
                        params: { description: 'follow up', prompt: 'keep going', agent_id: 'agent_abcdef' },
                    },
                ],
                undefined,
            ),
            textTurn('understood, asking for more characters', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher], undefined)] }),
        }).pipe(Effect.provideService(EventLog, sharedLog));

        const rootStarted = Option.getOrUndefined(
            Arr.findFirst(
                yield* session.entries,
                (entry) => Predicate.isTagged(entry, 'agent_started') && entry.parentAgentId === null,
            ),
        );

        if (!Predicate.isTagged(rootStarted, 'agent_started')) throw new Error('expected the root agent_started row');

        const twinIds = [
            AgentId.make(`agent_abcdef11${Str.repeat(16)('0')}`),
            AgentId.make(`agent_abcdef22${Str.repeat(16)('0')}`),
        ];

        yield* Effect.forEach(
            twinIds,
            (agentId, index) =>
                sharedLog
                    .append(
                        LogEntryInputs.agent_started({
                            agentId,
                            parentAgentId: rootStarted.agentId,
                            toolCallId: ToolCallId.make(`tool_call_${Str.repeat(24)(String(index))}`),
                            mode: 'fresh',
                            model: claudeActiveModel,
                            tools: [],
                            skill: null,
                            fork: null,
                            agentType: 'researcher',
                        }),
                    )
                    .pipe(Effect.orDie),
            { discard: true },
        );

        const finished = yield* session.send('go');
        expect(finished.outcome).toBe('completed');

        const entries = yield* session.entries;
        const rendered = yield* renderedDriveResult(entries, 0);
        expect(rendered).toContain('is ambiguous');
        expect(rendered).toContain('matches 2 agents');
        expect(rendered).toContain('agent_abcdef11');
        expect(rendered).toContain('agent_abcdef22');
        expect(rendered).toContain('Provide more characters');

        // Nothing resumed: the failure fired before any subagent run.
        expect(yield* researcherScripted.scripted.remainingTurns).toBe(0);
        expect(yield* rootScripted.scripted.remainingTurns).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
