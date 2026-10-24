import { it } from '@effect/vitest';
import { webFetchToolContract, webSearchToolContract, type FoldTool } from '@stegosaurus/fold-core';
import { Array as Arr, Effect, Fiber, Layer, Schema } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect } from 'vite-plus/test';

import type { Photon } from '../../src/Tools/Image/Photon';
import { webFetchTool } from '../../src/Tools/WebFetchTool';
import { webSearchTool } from '../../src/Tools/WebSearchTool';
import { handlerOf, makeAmbientServices, messageOf, realizeTool, runHandler } from '../TestHelpers';

const cases: ReadonlyArray<{
    readonly name: string;
    readonly tool: () => FoldTool<HttpClient.HttpClient | Photon>;
    readonly params: Record<string, string | number>;
    readonly timeoutMs: number;
    readonly message: string;
}> = [
    {
        name: 'fetch interprets fractional timeout_seconds as seconds',
        tool: webFetchTool,
        params: { url: 'https://example.com', timeout_seconds: 1.5 },
        timeoutMs: 1500,
        message: 'Request timed out after 1500ms',
    },
    {
        name: 'fetch defaults to 30 seconds',
        tool: webFetchTool,
        params: { url: 'https://example.com' },
        timeoutMs: 30_000,
        message: 'Request timed out after 30000ms',
    },
    {
        name: 'fetch caps timeout_seconds at 120 seconds',
        tool: webFetchTool,
        params: { url: 'https://example.com', timeout_seconds: 200 },
        timeoutMs: 120_000,
        message: 'Request timed out after 120000ms',
    },
    ...Arr.flatMap(['exa', 'parallel'] as const, (provider) => [
        {
            name: `${provider} search interprets seconds and overrides internal milliseconds`,
            tool: () => webSearchTool({ provider, timeoutMs: 100 }),
            params: { query: 'test', timeout_seconds: 1.5 },
            timeoutMs: 1500,
            message: `${provider === 'exa' ? 'web_search_exa' : 'web_search'} request timed out`,
        },
        {
            name: `${provider} search retains the 25-second default`,
            tool: () => webSearchTool({ provider }),
            params: { query: 'test' },
            timeoutMs: 25_000,
            message: `${provider === 'exa' ? 'web_search_exa' : 'web_search'} request timed out`,
        },
        {
            name: `${provider} search retains internal timeoutMs units`,
            tool: () => webSearchTool({ provider, timeoutMs: 250 }),
            params: { query: 'test' },
            timeoutMs: 250,
            message: `${provider === 'exa' ? 'web_search_exa' : 'web_search'} request timed out`,
        },
        {
            name: `${provider} search does not inherit the fetch timeout cap`,
            tool: () => webSearchTool({ provider }),
            params: { query: 'test', timeout_seconds: 150 },
            timeoutMs: 150_000,
            message: `${provider === 'exa' ? 'web_search_exa' : 'web_search'} request timed out`,
        },
    ]),
];

for (const testCase of cases) {
    it.effect(testCase.name, () =>
        Effect.gen(function* () {
            const signals: Array<AbortSignal> = [];

            const fetch: typeof globalThis.fetch = (_url: string | URL | Request, init: RequestInit | undefined) => {
                const { promise, reject } = Promise.withResolvers<Response>();
                const signal = init?.signal;

                if (signal === undefined || signal === null)
                    return Promise.reject(new Error('expected an abort signal'));
                signals.push(signal);
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
                    once: true,
                });

                return promise;
            };

            // Build the ambient services (photon loads for real) and the tool first, so the clock only times
            // the request.
            const ambient = yield* makeAmbientServices;
            const services = yield* Layer.build(ambient.layer);

            const handler = yield* realizeTool(testCase.tool()).pipe(
                Effect.provideContext(services),
                Effect.provide(FetchHttpClient.layer),
            );

            const fiber = yield* handler(testCase.params).pipe(
                Effect.provideContext(services),
                Effect.provide(FetchHttpClient.layer),
                Effect.provideService(FetchHttpClient.Fetch, fetch),
                Effect.flip,
                Effect.forkChild,
            );

            yield* TestClock.adjust(testCase.timeoutMs - 1);
            expect(signals).toHaveLength(1);
            expect(signals[0]?.aborted).toBe(false);
            expect(fiber.pollUnsafe()).toBeUndefined();

            yield* TestClock.adjust(1);
            const failure = yield* Fiber.join(fiber);
            expect(yield* messageOf(failure)).toBe(testCase.message);
            expect(signals[0]?.aborted).toBe(true);
        }),
    );
}

it.effect('web contracts decode optional numeric seconds and reject strings', () =>
    Effect.gen(function* () {
        for (const contract of [webFetchToolContract, webSearchToolContract]) {
            const params = { url: 'https://example.com', query: 'test' };
            const decode = Schema.decodeUnknownEffect(contract.parameters);
            expect(yield* decode({ ...params, timeout_seconds: 1.5 })).toHaveProperty('timeout_seconds', 1.5);
            expect(yield* decode(params)).not.toHaveProperty('timeout_seconds');
            expect(yield* decode({ ...params, timeout_seconds: '1.5' }).pipe(Effect.isFailure)).toBe(true);
        }

        expect(webFetchToolContract.parameters.fields).not.toHaveProperty('timeout');
    }),
);

it.effect('search clears its timeout after a successful response', () =>
    Effect.gen(function* () {
        const signals: Array<AbortSignal> = [];

        const fetch: typeof globalThis.fetch = (_url: string | URL | Request, init: RequestInit | undefined) => {
            const signal = init?.signal;

            if (signal === undefined || signal === null) throw new Error('expected an abort signal');
            signals.push(signal);

            return Promise.resolve(new Response('{"result":{"content":[{"text":"Search result"}]}}'));
        };

        const result = yield* runHandler(
            handlerOf(webSearchTool({ provider: 'exa' }))({ query: 'test', timeout_seconds: 1 }),
        ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch));

        expect(yield* messageOf(result)).toBe('Search result');
        yield* TestClock.adjust('2 seconds');
        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(false);
    }),
);
