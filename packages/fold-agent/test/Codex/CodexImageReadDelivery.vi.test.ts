/**
 * Deterministic end-to-end regression for the image-read path up to the Codex HTTP boundary. It executes
 * the real read tool and session prompt builder, then asserts the intended request emitted with no active tools.
 */
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, it } from '@effect/vitest';
import { CodexAuthStore, CodexTokenData, layerCodexAuthStore, makeCodexLanguageModel } from '@stegosaurus/fold-codex';
import { Array as Arr, Config, Effect, FileSystem, Layer, Option, Path, Predicate, Schema } from 'effect';
import { Base64 } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';

import { type CapturedFetchRequest, makeCapturingFetch, runImageReadInference } from './SessionModelPathTestHarness';

const terminalSse =
    'data: {"type":"response.completed","response":{"id":"resp_capture","model":"gpt-5.5","created_at":1,"output":[]},"sequence_number":1}\n\n';

const token = CodexTokenData.make({
    type: 'oauth',
    access: 'capture-access-token',
    refresh: 'unused-refresh-token',
    expires: Number.MAX_SAFE_INTEGER,
    accountId: 'acct_capture',
});

const CapturedResponsesRequest = Schema.Struct({
    model: Schema.String,
    stream: Schema.Boolean,
    input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    tools: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const decodeCapturedResponsesRequest = Schema.decodeEffect(Schema.fromJsonString(CapturedResponsesRequest));

const decodeWireContent = Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)));

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const isFilePart = (value: unknown): value is { readonly type: 'file' } =>
    Predicate.hasProperty(value, 'type') && value.type === 'file';

it.effect('sends an actual image read as input_image with zero inference tools', () => {
    const requests: Array<CapturedFetchRequest> = [];

    const capturingFetch = makeCapturingFetch(
        requests,
        () => new Response(terminalSse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );

    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const authStorePath = path.join(
            yield* fs.makeTempDirectoryScoped({ prefix: 'fold-codex-image-read-' }),
            'auth.json',
        );

        yield* Effect.gen(function* () {
            const store = yield* CodexAuthStore;
            yield* store.save(token);
        }).pipe(Effect.provide(layerCodexAuthStore({ path: authStorePath })));

        const model = yield* makeCodexLanguageModel({
            model: 'gpt-5.5',
            reasoning: 'off',
            apiUrl: 'https://codex.capture.test/backend-api/codex',
            authStorePath,
            requestRetryTimes: 0,
        });

        const fixture = yield* runImageReadInference(model);

        expect(requests).toHaveLength(1);
        const captured = requests[0];

        if (captured === undefined) throw new Error('expected one captured Responses request');
        expect(captured.url).toBe('https://codex.capture.test/backend-api/codex/responses');
        expect(captured.authorization).toBe('Bearer capture-access-token');

        const dumpRequest = yield* Config.String('FOLD_CODEX_DUMP_IMAGE_READ_REQUEST').pipe(Config.option);

        if (Option.contains(dumpRequest, '1')) {
            yield* Effect.sync(() => process.stdout.write(`${captured.body}\n`));
        }

        const body = yield* decodeCapturedResponsesRequest(captured.body);
        expect(body.model).toBe('gpt-5.5');
        expect(body.stream).toBe(true);
        // AgentRuntime passes an empty active toolkit; the provider omits `tools` entirely on the wire.
        expect(body.tools).toBeUndefined();

        // The production read tool returned the exact generated PNG, and RequestBuilder lowered it to
        // native Prompt parts inside the original tool result.
        expect(yield* encodeJson(fixture.readResult)).toContain(fixture.sourceImageBase64);

        const promptFileParts = Arr.flatMap(fixture.prompt.content, (message) => {
            if (message.role !== 'tool') return [];

            return Arr.flatMap(message.content, (part) =>
                part.type === 'tool-result' && Arr.isArray(part.result) ? Arr.filter(part.result, isFilePart) : [],
            );
        });

        expect(promptFileParts).toHaveLength(1);
        const promptImage = promptFileParts[0];

        if (!Predicate.hasProperty(promptImage, 'data') || !(promptImage.data instanceof Uint8Array))
            throw new Error('expected decoded image bytes');
        expect(Base64.encode(promptImage.data)).toBe(fixture.sourceImageBase64);

        // Text and image stay correlated in the native multipart function output.
        const functionOutput = Arr.findFirst(body.input, (item) => item['type'] === 'function_call_output');

        if (Option.isNone(functionOutput) || !Arr.isArray(functionOutput.value['output']))
            throw new Error('expected multipart function_call_output');
        const functionContent = yield* decodeWireContent(functionOutput.value['output']);
        const imageParts = Arr.filter(functionContent, (part) => part['type'] === 'input_image');
        expect(imageParts).toHaveLength(1);
        expect(imageParts[0]?.['image_url']).toBe(`data:image/png;base64,${fixture.sourceImageBase64}`);
        expect(Arr.filter(functionContent, (part) => part['type'] === 'input_text')).toHaveLength(1);
        expect(captured.body).not.toContain('Image omitted here');
        expect(captured.body).not.toContain('The following image content belongs');
        expect(captured.body).toContain(fixture.sourceImageBase64);
    }).pipe(
        Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeFileSystem.layer, NodePath.layer)),
        Effect.provideService(FetchHttpClient.Fetch, capturingFetch),
    );
});
