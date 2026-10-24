/**
 * Mid-session model switch example on the high-level API: turn 1 runs on OpenAI (gpt family), then
 * `session.switchModel` moves the same session to Anthropic (claude family) and turn 2 continues the
 * same durable log.
 *
 * The switch durably records the D17 epoch transition - `model-change`, a recomposed leading
 * `system-message` for the new family (latest leading wins; the family base prompts below make the
 * recomposition visible), and `tools-change` with the newly resolved toolset - and provisions the new
 * provider for every subsequent send. The printed log tags show all three entries between the turns.
 *
 * Run: OPENAI_API_KEY=... ANTHROPIC_API_KEY=... bun packages/fold-core/examples/ModelSwitch.ts
 */
import { Array as Arr, Cause, Config, Console, Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { anthropicModel, defineAgent, defineTool, openaiModel, Session } from '../src/index';

const echo = defineTool({
    name: 'echo',
    description: 'Echoes text back to the model.',
    parameters: Schema.Struct({ text: Schema.String }),
    success: Schema.Struct({ echoed: Schema.String }),
    handler: ({ text }) => Effect.succeed({ echoed: text }),
});

const makeProgram = (openAiModelId: string, anthropicModelId: string, openAiKey: string, anthropicKey: string) =>
    Effect.gen(function* () {
        const session = yield* Session.open({
            agent: defineAgent({
                name: 'model-switch-demo',
                model: openaiModel({ model: openAiModelId, apiKey: openAiKey, reasoning: 'medium' }),
                // The agent's own prompt blocks stay constant across epochs; the family base prompt
                // swaps around them when the model family changes.
                systemPrompt:
                    'You are a tiny Fold demo agent. When the user asks you to echo text, call the echo tool, then answer briefly.',
                basePrompts: {
                    gpt: 'GPT family base prompt: keep answers terse.',
                    claude: 'Claude family base prompt: explain what you did in one sentence.',
                },
                tools: [echo],
            }),
        });

        const first = yield* session.send('Use the echo tool with the exact text "hello from openai".');
        yield* Console.log(`turn 1 (${openAiModelId}): ${first.resultText ?? '(no text)'}`);

        yield* session.switchModel(
            anthropicModel({ model: anthropicModelId, apiKey: anthropicKey, reasoning: 'medium' }),
            {
                reason: 'user switched providers',
            },
        );

        const second = yield* session.send('Echo "hello from anthropic", and tell me what your base instructions say.');
        yield* Console.log(`turn 2 (${anthropicModelId}): ${second.resultText ?? '(no text)'}`);

        const entries = yield* session.entries;
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
    const openAiModelId = yield* Config.String('OPENAI_MODEL').pipe(Config.withDefault('gpt-5.5'));
    const anthropicModelId = yield* Config.String('ANTHROPIC_MODEL').pipe(Config.withDefault('claude-opus-4-8'));
    const openAiKey = yield* Config.String('OPENAI_API_KEY').pipe(Config.withDefault(''));
    const anthropicKey = yield* Config.String('ANTHROPIC_API_KEY').pipe(Config.withDefault(''));

    if (openAiKey === '' || anthropicKey === '') {
        yield* Console.error('Set OPENAI_API_KEY and ANTHROPIC_API_KEY to run this example.');
        process.exitCode = 1;

        return;
    }

    yield* makeProgram(openAiModelId, anthropicModelId, openAiKey, anthropicKey);
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
