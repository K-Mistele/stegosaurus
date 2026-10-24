/**
 * Minimal real-model example against the OpenAI API using the high-level API: describe the agent
 * (model, prompt, an inline tool), start a session, send one turn. All service wiring - event log,
 * toolset, hooks, system prompt, request settings, runtime layers - stays inside `Session.open`.
 *
 * Run: OPENAI_API_KEY=... bun packages/fold-core/examples/OpenaiAgent.ts
 */
import { Array as Arr, Cause, Config, Console, Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { defineAgent, defineTool, openaiModel, Session } from '../src/index';

const echo = defineTool({
    name: 'echo',
    description: 'Echoes text back to the model.',
    parameters: Schema.Struct({ text: Schema.String }),
    success: Schema.Struct({ echoed: Schema.String }),
    handler: ({ text }) => Effect.succeed({ echoed: text }),
});

const makeProgram = (modelId: string, apiKey: string) =>
    Effect.gen(function* () {
        const session = yield* Session.open({
            agent: defineAgent({
                name: 'openai-demo',
                model: openaiModel({ model: modelId, apiKey, reasoning: 'medium' }),
                systemPrompt:
                    'You are a tiny Fold demo agent. When the user asks you to echo text, call the echo tool, then answer briefly.',
                tools: [echo],
            }),
        });

        const finished = yield* session.send(
            'Use the echo tool with the exact text "hello from fold", then tell me what it returned.',
        );

        const entries = yield* session.entries;

        yield* Console.log(`finished: ${finished.outcome}`);
        yield* Console.log(`result: ${finished.resultText ?? '(no text)'}`);
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
    const modelId = yield* Config.String('OPENAI_MODEL').pipe(Config.withDefault('gpt-5.5'));
    const apiKey = yield* Config.String('OPENAI_API_KEY').pipe(Config.withDefault(''));

    if (apiKey === '') {
        yield* Console.error('Set OPENAI_API_KEY to run this example.');
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
