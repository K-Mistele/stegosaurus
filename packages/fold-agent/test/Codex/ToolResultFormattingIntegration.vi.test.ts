/**
 * RED integration coverage for model-facing built-in tool results. The fixture executes production
 * handlers against real files/processes, persists their untouched values, projects the session prompt,
 * and captures the JSON emitted by the stock OpenAI Responses provider.
 */
import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, it } from '@effect/vitest';
import { OpenAiClient, OpenAiLanguageModel } from '@stegosaurus/effect-ai-openai';
import { ToolResultFailure, ToolResultText } from '@stegosaurus/fold-core';
import { Array as Arr, Effect, FileSystem, Layer, Path, Predicate, Redacted, Schema } from 'effect';
import { LanguageModel } from 'effect/ai';
import { FetchHttpClient } from 'effect/http';

import { bashTool, editTool, readTool, writeTool } from '../../src/index';
import {
    buildSessionPromptWithToolResults,
    type CapturedFetchRequest,
    decodeToolResultJson,
    executeToolHandler,
    makeCapturingFetch,
    makeTemporaryTestDirectory,
} from './SessionModelPathTestHarness';

const openAiResponse = {
    id: 'resp_tool_result_formatting',
    object: 'response',
    created_at: 0,
    model: 'gpt-test',
    status: 'completed',
    output: [],
    metadata: null,
    temperature: null,
    top_p: null,
    tools: [],
    tool_choice: 'auto',
    error: null,
    incomplete_details: null,
    instructions: null,
    parallel_tool_calls: true,
};

const CapturedResponsesRequest = Schema.Struct({
    input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});

const decodeCapturedResponsesRequest = Schema.decodeEffect(Schema.fromJsonString(CapturedResponsesRequest));

const outputStringsFrom = (body: string): Effect.Effect<ReadonlyArray<string>, Schema.SchemaError> =>
    Effect.map(decodeCapturedResponsesRequest(body), (request) =>
        Arr.flatMap(request.input, (item) => {
            const output = item['output'];

            return item['type'] === 'function_call_output' && Predicate.isString(output) ? [output] : [];
        }),
    );

const expectedModelText = [
    '1→read alpha\n2→read beta\n3→',
    'bash success\n',
    'bash failure\n\n\nCommand exited with code 7',
    'Successfully wrote 16 bytes to nested/written.txt',
    'Successfully replaced 1 block(s) in editable.txt.',
];

const expectedDurableResults: ReadonlyArray<Schema.Json> = [
    ToolResultText.make({ text: '1→read alpha\n2→read beta\n3→' }),
    ToolResultText.make({ text: 'bash success\n' }),
    ToolResultFailure.make({ text: 'bash failure\n\n\nCommand exited with code 7' }),
    ToolResultText.make({ text: 'Successfully wrote 16 bytes to nested/written.txt' }),
    ToolResultText.make({ text: 'Successfully replaced 1 block(s) in editable.txt.' }),
];

const makeActualBuiltInToolResults = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* makeTemporaryTestDirectory('fold-tool-result-formatting-');
    yield* fs.writeFileString(path.join(directory, 'read-source.txt'), 'read alpha\nread beta\n').pipe(Effect.orDie);
    yield* fs.writeFileString(path.join(directory, 'editable.txt'), 'before edit\nkeep\n').pipe(Effect.orDie);

    const readResult = yield* executeToolHandler(readTool({ cwd: directory }), { path: 'read-source.txt' });

    const bashSuccessResult = yield* executeToolHandler(bashTool({ cwd: directory }), {
        command: "printf 'bash success\\n'",
    });

    const bashFailureResult = yield* executeToolHandler(bashTool({ cwd: directory }), {
        command: "printf 'bash failure\\n'; exit 7",
    }).pipe(Effect.flip);

    const writeResult = yield* executeToolHandler(writeTool({ cwd: directory }), {
        path: 'nested/written.txt',
        content: 'written by tool\n',
    });

    const editResult = yield* executeToolHandler(editTool({ cwd: directory }), {
        path: 'editable.txt',
        edits: [{ oldText: 'before edit', newText: 'after edit' }],
    });

    const rawResults = yield* Effect.all([
        decodeToolResultJson(readResult),
        decodeToolResultJson(bashSuccessResult),
        decodeToolResultJson(bashFailureResult),
        decodeToolResultJson(writeResult),
        decodeToolResultJson(editResult),
    ]);

    const names = ['read', 'bash', 'bash', 'write', 'edit'];

    const params = [
        { path: 'read-source.txt' },
        { command: "printf 'bash success\\n'" },
        { command: "printf 'bash failure\\n'; exit 7" },
        { path: 'nested/written.txt', content: 'written by tool\n' },
        { path: 'editable.txt', edits: [{ oldText: 'before edit', newText: 'after edit' }] },
    ];

    const { prompt, entries } = yield* buildSessionPromptWithToolResults({
        userText: 'Run the requested built-in operations.',
        toolResults: Arr.map(rawResults, (result, index) => ({
            name: names[index] ?? 'unexpected',
            params: params[index] ?? {},
            result,
            isFailure: index === 2,
        })),
    });

    return { directory, rawResults, prompt, entries };
}).pipe(Effect.provide(NodeServices.layer));

it.live('keeps actual built-in handler values structured in the durable EventLog', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { directory, entries, rawResults } = yield* makeActualBuiltInToolResults;

        assert.deepStrictEqual([...rawResults], expectedDurableResults);
        assert.deepStrictEqual(
            Arr.map(entries, (entry) => {
                const part = entry.message.content[0];

                if (part?.type !== 'tool-result') throw new Error('expected a durable tool-result part');

                return part.result;
            }),
            rawResults,
        );
        assert.strictEqual(yield* fs.readFileString(path.join(directory, 'nested/written.txt')), 'written by tool\n');
        assert.strictEqual(yield* fs.readFileString(path.join(directory, 'editable.txt')), 'after edit\nkeep\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('RED: sends actual built-in tool results as plain Responses function outputs', () =>
    Effect.gen(function* () {
        const { prompt } = yield* makeActualBuiltInToolResults;

        const requests: Array<CapturedFetchRequest> = [];
        const openAiResponseText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(openAiResponse);

        const capturingFetch = makeCapturingFetch(
            requests,
            () =>
                new Response(openAiResponseText, {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );

        const httpLayer = FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, capturingFetch)),
        );

        const clientLayer = OpenAiClient.layer({ apiKey: Redacted.make('sk-test') }).pipe(Layer.provide(httpLayer));
        const modelLayer = OpenAiLanguageModel.model('gpt-test').pipe(Layer.provide(clientLayer));

        yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(modelLayer));

        assert.strictEqual(requests.length, 1);
        const captured = requests[0];

        if (captured === undefined) throw new Error('expected one captured OpenAI Responses request');
        assert.strictEqual(captured.url, 'https://api.openai.com/v1/responses');

        // Intended model contract: expose each handler's inner text/output/message, never its JSON envelope.
        assert.deepStrictEqual(yield* outputStringsFrom(captured.body), expectedModelText);
    }),
);
