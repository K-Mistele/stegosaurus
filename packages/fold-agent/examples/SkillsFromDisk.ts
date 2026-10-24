/**
 * Disk-backed skills example: SKILL.md files discovered through the standard scan chain - the user
 * directory (`~/.fold/skills`), the git repo root (`$REPO/.agents/skills`), and the working directory
 * (`$CWD/.agents/skills`), later roots shadowing earlier ones on duplicate names. To keep the demo
 * self-contained (and off your real home directory), it materializes a fake home and a fake repo in a
 * temp folder and points the loader at them - the exact override seam tests use.
 *
 * Run: ANTHROPIC_API_KEY=... bun packages/fold-agent/examples/SkillsFromDisk.ts
 */
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { anthropicModel, defineAgent, skillTool, Session } from '@stegosaurus/fold-core';
import { Config, Console, Effect, FileSystem, Layer, Path } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { skillsFromDisk } from '../src/index';

const skillFile = (name: string, description: string, body: string): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** Lay out a fake home + repo: one global skill, one repo skill that shadows a global duplicate. */
const materializeSkillTree = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: 'fold-skills-demo-' });
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'packages', 'app');

    // User directory: ~/.fold/skills
    yield* fs.makeDirectory(path.join(home, '.fold', 'skills', 'sign-off'), { recursive: true });
    yield* fs.writeFileString(
        path.join(home, '.fold', 'skills', 'sign-off', 'SKILL.md'),
        skillFile(
            'sign-off',
            'How to sign off replies. Use for every reply.',
            'End every reply with "-- global fold".',
        ),
    );

    // Git repo root: $REPO/.agents/skills (shadows the global sign-off).
    yield* fs.makeDirectory(path.join(repo, '.git'), { recursive: true });
    yield* fs.makeDirectory(path.join(repo, '.agents', 'skills', 'sign-off'), { recursive: true });
    yield* fs.writeFileString(
        path.join(repo, '.agents', 'skills', 'sign-off', 'SKILL.md'),
        skillFile('sign-off', 'How to sign off replies. Use for every reply.', 'End every reply with "-- repo fold".'),
    );

    yield* fs.makeDirectory(cwd, { recursive: true });

    return { home, cwd };
});

const makeProgram = (apiKey: string, modelId: string) =>
    Effect.gen(function* () {
        const { home, cwd } = yield* materializeSkillTree;
        yield* Console.log(`fake home: ${home}`);
        yield* Console.log(`fake cwd:  ${cwd}`);

        const session = yield* Session.open({
            agent: defineAgent({
                name: 'disk-skills-demo',
                model: anthropicModel({ model: modelId, apiKey, reasoning: 'medium' }),
                systemPrompt: 'You are a tiny Fold demo agent.',
                // Omit home/cwd to scan the real chain (~/.fold/skills, repo root, process cwd).
                tools: [skillTool(skillsFromDisk({ home, cwd }))],
            }),
        });

        // The repo skill shadows the global one, so the model should sign off with "-- repo fold".
        const finished = yield* session.send('Load the sign-off skill and answer: what is 2 + 2?');

        yield* Console.log(`finished: ${finished.outcome}`);
        yield* Console.log(`result:\n${finished.resultText ?? '(no text)'}`);
    }).pipe(Effect.scoped);

const main = Effect.gen(function* () {
    const modelId = yield* Config.String('ANTHROPIC_MODEL').pipe(Config.withDefault('claude-opus-4-8'));
    const apiKey = yield* Config.String('ANTHROPIC_API_KEY').pipe(Config.withDefault(''));

    if (apiKey === '') {
        yield* Console.error('Set ANTHROPIC_API_KEY to run this example.');
        yield* Effect.sync(() => {
            process.exitCode = 1;
        });

        return;
    }

    yield* makeProgram(apiKey, modelId);
});

// oxlint-disable-next-line effecttsgo/strict-effect-provide -- entry point
NodeRuntime.runMain(main.pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))));
