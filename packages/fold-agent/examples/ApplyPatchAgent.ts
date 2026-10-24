/**
 * Codex/gpt-family editing example: the same coding toolset as CodingAgent, but on a gpt-family model
 * the ToolsetResolver hides write/edit and advertises apply_patch instead - the model edits files by
 * emitting V4A patches (raw git/unified diffs are accepted too). Nothing tool-side changes between
 * families; only the advertised subset flips.
 *
 * Run: OPENAI_API_KEY=... bun packages/fold-agent/examples/ApplyPatchAgent.ts
 */
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { defineAgent, openaiModel, Session } from '@stegosaurus/fold-core';
import { Array as Arr, Config, Predicate, Console, Effect, FileSystem, Layer, Path } from 'effect';

import { codingTools, layerCodingToolServices } from '../src/index';

const makeProgram = (apiKey: string, modelId: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fs.makeTempDirectory({ prefix: 'fold-patch-demo-' });
        yield* fs.writeFileString(path.join(workspace, 'config.json'), '{\n  "retries": 1,\n  "verbose": false\n}\n');
        yield* Console.log(`workspace: ${workspace}`);

        // The coding tools' services live as long as the session, in this program's scope.
        const toolServices = yield* Layer.build(
            layerCodingToolServices({ outputDirectory: path.join(workspace, 'tool-output') }),
        );

        const session = yield* Session.open({
            agent: defineAgent({
                name: 'apply-patch-demo',
                model: openaiModel({ model: modelId, apiKey, reasoning: 'medium' }),
                systemPrompt:
                    'You are a small coding agent working in the current directory. ' +
                    'Read files before patching them; keep answers short.',
                tools: codingTools({ cwd: workspace }),
            }),
            cwd: workspace,
        }).pipe(Effect.provideContext(toolServices));

        const finished = yield* session.send(
            'Read config.json, then use apply_patch to set "retries" to 3 and read it back to confirm.',
        );

        const entries = yield* session.entries;

        const toolNames = Arr.flatMap(entries, (entry) =>
            Predicate.isTagged(entry, 'tool-result')
                ? [entry.message.content[0]?.type === 'tool-result' ? entry.message.content[0].name : '']
                : [],
        );

        yield* Console.log(`finished: ${finished.outcome}`);
        yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`);
        yield* Console.log(`tools called: ${Arr.join(toolNames, ', ')}`);
    }).pipe(Effect.scoped);

const main = Effect.gen(function* () {
    const modelId = yield* Config.String('OPENAI_MODEL').pipe(Config.withDefault('gpt-5.5'));
    const apiKey = yield* Config.String('OPENAI_API_KEY').pipe(Config.withDefault(''));

    if (apiKey === '') {
        yield* Console.error('Set OPENAI_API_KEY to run this example.');
        yield* Effect.sync(() => {
            process.exitCode = 1;
        });

        return;
    }

    yield* makeProgram(apiKey, modelId);
});

// oxlint-disable-next-line effecttsgo/strict-effect-provide -- entry point
NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
