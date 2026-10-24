import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
/**
 * Engine tests for skills in the subagent slice (D20/D21, round-five shape): a skillTool VALUE shared
 * by reference between agents is initialized once (one scan, one snapshot) and gives both the same
 * roster; the dispatch-time `skill` preload resolves through the DISPATCHER's own skillTool and is
 * injected as a second user message after the prompt; a dispatcher whose tools carry no skillTool gets
 * a typed failure before any subagent row is written.
 */
import { expect, it } from '@effect/vitest';
import { Array as Arr, Predicate, Effect, Ref, Option, Schema } from 'effect';

import {
    defineAgent,
    defineSubagent,
    skillSource,
    skillTool,
    Session,
    subagentTool,
    type SkillSourceService,
    type UserMessageLogEntry,
} from '../../src/index';
import { claudeActiveModel, gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers';
import { textTurn, toolCallTurn } from '../TestLayers/ScriptedLanguageModel';
import { subagentStartedEntries } from './DriveHarness';

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A skill source that counts list() scans, to prove shared values are initialized once. */
const makeCountingSource = () =>
    Effect.gen(function* () {
        const scans = yield* Ref.make(0);

        const source: SkillSourceService = {
            list: Ref.update(scans, (count) => count + 1).pipe(
                Effect.as([{ name: 'commit-helper', description: 'Craft commit messages' }]),
            ),
            load: (name) => Effect.succeed({ name, description: 'x', content: `content of ${name}`, baseDir: null }),
        };

        return { source, scans: Ref.get(scans) };
    });

it.effect('a shared skillTool value scans once; the preload rides the dispatcher source into the subagent', () =>
    Effect.gen(function* () {
        const counting = yield* makeCountingSource();
        const sharedSkillTool = Effect.succeed(counting.source).pipe(skillSource, skillTool);

        const researcherScripted = yield* scriptedModel(claudeActiveModel, [textTurn('done researching', undefined)]);

        const researcher = defineSubagent({
            name: 'researcher',
            description: 'explores',
            model: researcherScripted.model,
            tools: [sharedSkillTool], // shares the root's value by reference
        });

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'r1',
                        name: 'subagent',
                        params: {
                            description: 'd',
                            prompt: 'research it',
                            agent: 'researcher',
                            skill: 'commit-helper',
                        },
                    },
                ],
                undefined,
            ),
            textTurn('root done', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({
                model: rootScripted.model,
                tools: [sharedSkillTool, subagentTool([researcher], undefined)],
            }),
        });

        const finished = yield* session.send('go');
        expect(finished.outcome).toBe('completed');

        // One value, one init, one scan - shared across root and researcher.
        expect(yield* counting.scans).toBe(1);

        const entries = yield* session.entries;
        const started = subagentStartedEntries(entries)[0];

        if (started === undefined) throw new Error('expected the subagent to have started');
        expect(started.skill).toBe('commit-helper');
        expect(started.tools).toContain('skill');

        // D21 message order: dispatch prompt first, skill invocation second.
        const subagentUserMessages = Arr.filter(
            entries,
            (entry): entry is UserMessageLogEntry =>
                Predicate.isTagged(entry, 'user-message') && entry.agentId === started.agentId,
        );

        expect(subagentUserMessages).toHaveLength(2);
        expect(yield* encodeJsonText(subagentUserMessages[0])).toContain('research it');
        expect(yield* encodeJsonText(subagentUserMessages[1])).toContain('<skill name=');
        expect(yield* encodeJsonText(subagentUserMessages[1])).toContain('content of commit-helper');

        // The subagent's own leading prompt carries the shared skills block.
        const subagentSystem = Option.getOrUndefined(
            Arr.findFirst(
                entries,
                (entry) => Predicate.isTagged(entry, 'system-message') && entry.agentId === started.agentId,
            ),
        );

        expect(yield* encodeJsonText(subagentSystem)).toContain('available_skills');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect('a dispatcher with no skillTool cannot preload: typed failure before any subagent row', () =>
    Effect.gen(function* () {
        const workerScripted = yield* scriptedModel(claudeActiveModel, []);
        const worker = defineSubagent({ name: 'worker', description: 'works', model: workerScripted.model });

        const rootScripted = yield* scriptedModel(gptActiveModel, [
            toolCallTurn(
                [
                    {
                        id: 'r1',
                        name: 'subagent',
                        params: { description: 'd', prompt: 'work', agent: 'worker', skill: 'commit-helper' },
                    },
                ],
                undefined,
            ),
            textTurn('root recovered', undefined),
        ]);

        const session = yield* Session.open({
            agent: defineAgent({ model: rootScripted.model, tools: [subagentTool([worker], undefined)] }),
        });

        const finished = yield* session.send('go');
        expect(finished.outcome).toBe('completed');

        const entries = yield* session.entries;
        // No subagent was started: the preload failed before any durable subagent row.
        expect(subagentStartedEntries(entries)).toHaveLength(0);

        const toolResult = Option.getOrUndefined(
            Arr.findFirst(entries, (entry) => Predicate.isTagged(entry, 'tool-result')),
        );

        expect(yield* encodeJsonText(toolResult)).toContain('Skill \\"commit-helper\\" not found');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
