import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
/**
 * Slice-2 steering tests (D8): `steer` queues onto a RUNNING agent and drains between that agent's
 * turns - after the in-flight batch, before the next model call - landing as an ordinary user-message
 * exactly where the model saw it. Modes: one-at-a-time (default) drains one message per boundary,
 * `all` drains the whole queue. Steering an idle agent is a typed failure pointing at send. Subagents
 * are steerable by agentId, draining between the CHILD's turns with the dispatch envelope.
 */
import { expect, it } from '@effect/vitest';
import { Array as Arr, Option, Predicate, Effect, Fiber, Schema, String as Str } from 'effect';

import { defineAgent, defineSubagent, Session, subagentTool, type UserMessageLogEntry } from '../../src/index';
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel';
import { claudeActiveModel, gptActiveModel, scriptedModel } from './ApiTestHelpers';
import { makeGateTool } from './SessionControlHarness';

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect('steering a running root drains between turns, exactly where the model saw it', () =>
    Effect.gen(function* () {
        const gate = yield* makeGateTool('gate');

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn([{ id: 'provider-call-1', name: 'gate', params: {} }], undefined),
            textTurn('done', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model: rootScripted.model, tools: [gate.tool] }),
        });

        const sendFiber = yield* Effect.forkScoped(session.send('go'));
        yield* gate.invoked;
        yield* session.steer('change course');
        yield* gate.release;

        const finished = yield* Fiber.join(sendFiber);
        expect(finished.outcome).toBe('completed');

        // The steered message landed AFTER the batch's tool result and BEFORE the next assistant turn.
        const entries = yield* session.entries;
        const tags = Arr.map(entries, (entry) => entry._tag);
        const toolResultIndex = tags.indexOf('tool-result');
        const entryJsons = yield* Effect.forEach(entries, (entry) => encodeJson(entry));

        const steeredIndex = Option.getOrElse(
            Arr.findFirstIndex(
                entries,
                (entry, index) =>
                    Predicate.isTagged(entry, 'user-message') && Str.includes('change course')(entryJsons[index] ?? ''),
            ),
            () => -1,
        );

        const finalAssistantIndex = tags.lastIndexOf('assistant-message');
        expect(steeredIndex).toBeGreaterThan(toolResultIndex);
        expect(steeredIndex).toBeLessThan(finalAssistantIndex);

        // The next model call - and only that one - saw the steered message.
        const prompts = yield* rootScripted.scripted.prompts;
        expect(yield* encodeJson(prompts[0])).not.toContain('change course');
        expect(yield* encodeJson(prompts[1])).toContain('change course');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('one-at-a-time steering drains one message per turn boundary', () =>
    Effect.gen(function* () {
        const firstGate = yield* makeGateTool('gate_one');
        const secondGate = yield* makeGateTool('gate_two');

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn([{ id: 'provider-call-1', name: 'gate_one', params: {} }], undefined),
            toolCallTurn([{ id: 'provider-call-2', name: 'gate_two', params: {} }], undefined),
            textTurn('done', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model: rootScripted.model, tools: [firstGate.tool, secondGate.tool] }),
        });

        const sendFiber = yield* Effect.forkScoped(session.send('go'));
        yield* firstGate.invoked;
        yield* session.steer('first steer');
        yield* session.steer('second steer');
        yield* firstGate.release;
        yield* secondGate.invoked;
        yield* secondGate.release;
        yield* Fiber.join(sendFiber);

        const prompts = yield* rootScripted.scripted.prompts;
        expect(yield* encodeJson(prompts[1])).toContain('first steer');
        expect(yield* encodeJson(prompts[1])).not.toContain('second steer');
        expect(yield* encodeJson(prompts[2])).toContain('second steer');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("steering mode 'all' drains the whole queue at one boundary", () =>
    Effect.gen(function* () {
        const gate = yield* makeGateTool('gate');

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn([{ id: 'provider-call-1', name: 'gate', params: {} }], undefined),
            textTurn('done', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model: rootScripted.model, tools: [gate.tool] }),
            steering: 'all',
        });

        const sendFiber = yield* Effect.forkScoped(session.send('go'));
        yield* gate.invoked;
        yield* session.steer('first steer');
        yield* session.steer('second steer');
        yield* gate.release;
        yield* Fiber.join(sendFiber);

        const nextPrompt = yield* encodeJson((yield* rootScripted.scripted.prompts)[1]);
        expect(nextPrompt).toContain('first steer');
        expect(nextPrompt).toContain('second steer');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('steering an idle agent fails typed, pointing at send', () =>
    Effect.gen(function* () {
        const rootScripted = yield* scriptedModel(gptActiveModel, []);
        const session = yield* Session.open({ agent: defineAgent({ model: rootScripted.model }) });

        const failure = yield* session.steer('too late').pipe(Effect.flip);
        expect(failure._tag).toBe('AgentNotRunningError');
        expect(failure.message).toContain('send(message, { agentId');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("steering a running subagent drains between the child's turns under the dispatch envelope", () =>
    Effect.gen(function* () {
        const gate = yield* makeGateTool('gate');

        const researcherScripted = yield* scriptedModel(claudeActiveModel, [
            toolCallTurn([{ id: 'child-call-1', name: 'gate', params: {} }], undefined),
            textTurn('child done', undefined),
        ]);

        const researcher = defineSubagent({
            name: 'researcher',
            description: 'explores',
            model: researcherScripted.model,
            tools: [gate.tool],
        });

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'provider-call-1',
                        name: 'subagent',
                        params: { description: 'explore', prompt: 'explore the module', agent: 'researcher' },
                    },
                ],
                undefined,
            ),
            textTurn('root done', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([researcher], undefined)] }),
        });

        const sendFiber = yield* Effect.forkScoped(session.send('go'));
        yield* gate.invoked;

        const midRun = yield* session.entries;

        const childStarted = Option.getOrUndefined(
            Arr.findFirst(
                midRun,
                (entry) => Predicate.isTagged(entry, 'agent_started') && entry.parentAgentId !== null,
            ),
        );

        if (childStarted === undefined || !Predicate.isTagged(childStarted, 'agent_started')) {
            throw new Error('expected the dispatched subagent to have started');
        }

        yield* session.steer('focus on the config file', { agentId: childStarted.agentId });
        yield* gate.release;
        const finished = yield* Fiber.join(sendFiber);
        expect(finished.outcome).toBe('completed');

        // The steered row belongs to the child, under the dispatching tool call (D2 envelope).
        const entries = yield* session.entries;
        const entryJsons = yield* Effect.forEach(entries, (entry) => encodeJson(entry));

        const steered = Option.getOrUndefined(
            Arr.findFirst(
                entries,
                (entry, index): entry is UserMessageLogEntry =>
                    Predicate.isTagged(entry, 'user-message') &&
                    Str.includes('focus on the config file')(entryJsons[index] ?? ''),
            ),
        );

        if (steered === undefined) throw new Error('expected the steered user-message');
        expect(steered.agentId).toBe(childStarted.agentId);
        expect(steered.toolCallId).toBe(childStarted.toolCallId);

        // The child's second model call - not the root's - saw the steering.
        const childPrompts = yield* researcherScripted.scripted.prompts;
        expect(yield* encodeJson(childPrompts[1])).toContain('focus on the config file');
        const rootPrompts = yield* rootScripted.scripted.prompts;
        expect(yield* encodeJson(rootPrompts)).not.toContain('focus on the config file');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
