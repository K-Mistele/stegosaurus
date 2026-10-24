/**
 * Isomorphic skills example: skills passed in as data (no filesystem anywhere), so the same setup runs
 * in a browser, worker, or server. The roster is read once at session start - it renders into the
 * leading system prompt and the skill tool's description - and the model loads full skill content on
 * demand through the skill tool (progressive disclosure). See fold-agent's SkillsFromDisk example for the
 * disk-backed variant.
 *
 * Run: ANTHROPIC_API_KEY=... bun packages/fold-core/examples/SkillsAgent.ts
 */
import { Array as Arr, Cause, Config, Console, Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { anthropicModel, defineAgent, skillsFromData, skillTool, Session } from '../src/index';

const skills = skillsFromData([
    {
        name: 'haiku-reviews',
        description: 'Write code reviews as haiku. Use when the user asks for a poetic or haiku code review.',
        content: Arr.join(
            [
                'When reviewing code, respond with exactly one haiku (5-7-5 syllables).',
                'The first line names the problem, the second the consequence, the third the fix.',
                'Never explain the haiku.',
            ],
            '\n',
        ),
    },
    {
        name: 'commit-messages',
        description: 'Craft conventional commit messages. Use when the user asks for a commit message.',
        content: 'Write commit messages as `type(scope): summary` with a body only when necessary.',
    },
]);

const makeProgram = (modelId: string, apiKey: string) =>
    Effect.gen(function* () {
        const session = yield* Session.open({
            agent: defineAgent({
                name: 'skills-demo',
                model: anthropicModel({ model: modelId, apiKey, reasoning: 'medium' }),
                systemPrompt: 'You are a tiny Fold demo agent.',
                tools: [skillTool(skills)],
            }),
        });

        const finished = yield* session.send(
            'Please give me a haiku code review of: `const x = JSON.parse(JSON.stringify(obj))`',
        );

        const entries = yield* session.entries;

        yield* Console.log(`finished: ${finished.outcome}`);
        yield* Console.log(`result:\n${finished.resultText ?? '(no text)'}`);
        yield* Console.log(
            `log: ${Arr.join(
                Arr.map(entries, (entry) => entry._tag),
                ' -> ',
            )}`,
        );
    }).pipe(
        Effect.scoped,
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- entry point
        Effect.provide(FetchHttpClient.layer),
    );

const main = Effect.gen(function* () {
    const modelId = yield* Config.String('ANTHROPIC_MODEL').pipe(Config.withDefault('claude-opus-4-8'));
    const apiKey = yield* Config.String('ANTHROPIC_API_KEY').pipe(Config.withDefault(''));

    if (apiKey === '') {
        yield* Console.error('Set ANTHROPIC_API_KEY to run this example.');
        process.exitCode = 1;

        return;
    }

    yield* makeProgram(modelId, apiKey);
}).pipe(
    Effect.catchCause((cause) =>
        Console.error(Cause.squash(cause)).pipe(
            Effect.andThen(
                Effect.sync(() => {
                    process.exitCode = 1;
                }),
            ),
        ),
    ),
);

Effect.runFork(main);
