/**
 * Filesystem coding agent: the full coding toolset (read, write, edit, apply_patch, bash) over a
 * scratch workspace, with the session log persisted as JSONL. The claude-family model is shown
 * write/edit (apply_patch stays hidden by the family policy); switching to a gpt/codex-family model
 * mid-session would flip the advertised editing tools automatically.
 *
 * Run: ANTHROPIC_API_KEY=... bun packages/fold-agent/examples/CodingAgent.ts
 */
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { anthropicModel, defineAgent, Session } from '@stegosaurus/fold-core';
import { Array as Arr, Config, Predicate, Console, Effect, FileSystem, Layer, Path } from 'effect';

import { codingTools, layerJsonl, layerCodingToolServices } from '../src/index';

const makeProgram = (apiKey: string, modelId: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fs.makeTempDirectory({ prefix: 'fold-coding-demo-' });
        const logPath = path.join(workspace, 'session.jsonl');
        yield* Console.log(`workspace: ${workspace}`);

        // The coding tools' services live as long as the session, in this program's scope.
        const toolServices = yield* Layer.build(
            layerJsonl(logPath).pipe(
                Layer.orDie,
                Layer.provideMerge(layerCodingToolServices({ outputDirectory: path.join(workspace, 'tool-output') })),
            ),
        );

        const session = yield* Session.open({
            agent: defineAgent({
                name: 'coding-demo',
                model: anthropicModel({ model: modelId, apiKey, reasoning: 'medium' }),
                systemPrompt:
                    'You are a small coding agent working in the current directory. ' +
                    'Use your tools to inspect and change files; keep answers short.',
                tools: codingTools({ cwd: workspace }),
            }),
            cwd: workspace,
        }).pipe(Effect.provideContext(toolServices));

        const finished = yield* session.send(
            'Create a file called greet.ts exporting `greet(name: string): string` returning "hello, {name}". ' +
                'Then use bash to print the file back with `cat greet.ts`, and finally change the greeting to "howdy" with an edit.',
        );

        const entries = yield* session.entries;

        yield* Console.log(`finished: ${finished.outcome}`);
        yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`);
        yield* Console.log(`log rows: ${entries.length} (persisted to ${logPath})`);
        yield* Console.log(
            `tools used: ${Arr.filter(entries, (entry) => Predicate.isTagged(entry, 'tool-result')).length} tool results`,
        );
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
NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
