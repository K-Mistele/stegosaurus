import { expect, it } from '@effect/vitest';
import { Array as Arr, Effect, Predicate, Order, Record as Rec, Schema, String as Str } from 'effect';
import { Prompt } from 'effect/ai';

import { AgentRuntime } from '../../src/index';
import { makeScriptedLanguageModel, textTurn } from '../TestLayers/ScriptedLanguageModel';
import { layerEchoTool, makeEchoRecorder } from '../TestLayers/TestTools';
import { agentRuntimeBaseLayer, runInput, startInput } from './AgentRuntimeTestHelpers';

const byEntryKey: Order.Order<readonly [string, Schema.Json]> = ([left], [right]) => Str.localeCompare(right)(left);

/** Drop cache-control metadata and sort object keys so equal prompts encode to identical JSON. */
const withoutCacheControl = (value: Schema.Json): Schema.Json => {
    if (Arr.isArray<Schema.Json>(value)) return Arr.map(value, withoutCacheControl);

    if (value === null || Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
        return value;
    }

    const out: Record<string, Schema.Json> = {};

    for (const [key, nested] of Arr.sort(Rec.toEntries(value), byEntryKey)) {
        if (key === 'cacheControl') continue;
        const normalized = withoutCacheControl(nested);

        if (key === 'anthropic' && Predicate.isObject(normalized) && Arr.isArrayEmpty(Rec.keys(normalized))) continue;
        out[key] = normalized;
    }

    return out;
};

const encodeMessages = Schema.encodeEffect(Schema.Array(Prompt.Message));

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const stablePromptJson = (messages: ReadonlyArray<Prompt.Message>) =>
    Effect.gen(function* () {
        const encoded = yield* encodeMessages(messages);
        const json = yield* decodeJson(encoded);

        return yield* encodeJsonString(withoutCacheControl(json));
    });

it.effect('keeps the second request prompt a byte-stable extension of the first', () =>
    Effect.gen(function* () {
        const recorder = yield* makeEchoRecorder;
        const scripted = yield* makeScriptedLanguageModel([textTurn('One', undefined), textTurn('Two', undefined)]);
        const layer = agentRuntimeBaseLayer(scripted.layer, layerEchoTool(recorder));

        yield* Effect.gen(function* () {
            const runtime = yield* AgentRuntime;

            yield* runtime.start(startInput({}));
            yield* runtime.run(runInput('first question'));
            yield* runtime.run(runInput('second question'));
        }).pipe(Effect.provide(layer));

        const prompts = yield* scripted.prompts;
        expect(prompts).toHaveLength(2);

        const first = prompts[0];
        const second = prompts[1];

        if (first === undefined || second === undefined) throw new Error('expected two captured prompts');

        // The prompt-cache law: excluding request-local cache breakpoint metadata, the second request
        // begins with exactly the first request's messages.
        expect(second.content.length).toBeGreaterThan(first.content.length);
        expect(yield* stablePromptJson(second.content.slice(0, first.content.length))).toBe(
            yield* stablePromptJson(first.content),
        );
    }),
);
