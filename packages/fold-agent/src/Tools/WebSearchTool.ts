import {
    CurrentAgent,
    defineTool,
    ToolResultFailure,
    ToolResultText,
    webSearchToolContract,
    type FoldTool,
} from '@stegosaurus/fold-core';
import { Array as Arr, Duration, Effect, Option, Schema, String as Str } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

const defaultTimeoutMs = 25_000;

const maxNumResults = 20;

const maxContextCharacters = 50_000;

const exaUrl = 'https://mcp.exa.ai/mcp';

const parallelUrl = 'https://search.parallel.ai/mcp';

export type WebSearchProvider = 'exa' | 'parallel';

export type WebSearchToolOptions = {
    readonly exaApiKey?: string;
    readonly parallelApiKey?: string;
    readonly provider?: WebSearchProvider;
    readonly timeoutMs?: number;
    readonly env?: (name: string) => string | undefined;
};

const resolveEnv = (options: WebSearchToolOptions | undefined, name: string): string | undefined =>
    // oxlint-disable-next-line effecttsgo/process-env -- Config treats an empty variable as missing, which would change provider fallback
    options?.env?.(name) ?? process.env[name];

const resolveExaUrl = (options: WebSearchToolOptions | undefined): string => {
    const apiKey = options?.exaApiKey ?? resolveEnv(options, 'EXA_API_KEY');

    if (apiKey === undefined || apiKey.length === 0) return exaUrl;
    const url = new URL(exaUrl);
    url.searchParams.set('exaApiKey', apiKey);

    return url.toString();
};

const resolveParallelHeaders = (options: WebSearchToolOptions | undefined) => {
    const apiKey = options?.parallelApiKey ?? resolveEnv(options, 'PARALLEL_API_KEY');
    const userAgent = { 'User-Agent': 'fold/1.0' };

    return apiKey !== undefined && apiKey.length > 0 ? { ...userAgent, Authorization: `Bearer ${apiKey}` } : userAgent;
};

const checksum = (text: string): number => {
    let hash = 0;

    for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + Option.getOrElse(Str.charCodeAt(text, index), () => Number.NaN)) >>> 0;
    }

    return hash;
};

const selectProvider = (seed: string, options: WebSearchToolOptions | undefined): WebSearchProvider => {
    const override =
        options?.provider ??
        resolveEnv(options, 'FOLD_WEBSEARCH_PROVIDER') ??
        resolveEnv(options, 'OPENCODE_WEBSEARCH_PROVIDER');

    if (override === 'exa' || override === 'parallel') return override;

    return checksum(seed) % 2 === 0 ? 'exa' : 'parallel';
};

/** The JSON-RPC `tools/call` request both MCP search endpoints accept. */
const McpToolCall = Schema.Struct({
    jsonrpc: Schema.Literal('2.0'),
    id: Schema.Finite,
    method: Schema.Literal('tools/call'),
    params: Schema.Struct({
        name: Schema.String,
        arguments: Schema.Record(Schema.String, Schema.Json),
    }),
});

/** The part of a JSON-RPC `tools/call` response the tool reads: the result's content blocks. */
const McpToolResponse = Schema.Struct({
    result: Schema.optional(
        Schema.Struct({
            content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
        }),
    ),
});

type McpToolResponse = typeof McpToolResponse.Type;

const decodeMcpPayload = Schema.decodeEffect(Schema.fromJsonString(McpToolResponse));

const firstText = (response: McpToolResponse): Option.Option<string> =>
    Option.flatMap(Option.fromUndefinedOr(response.result?.content), (content) =>
        Arr.findFirst(content, ({ text }) => Option.filter(Option.fromUndefinedOr(text), Str.isNonEmpty)),
    );

/** A web search failed; `message` is shown to the model. */
class McpFailure extends Schema.TaggedError<McpFailure, { readonly brand: unique symbol }>()('McpFailure', {
    message: Schema.String,
}) {}

/** Decode one JSON payload (a whole body or an SSE `data:` line); non-JSON payloads carry no result. */
const parsePayload = (payload: string): Effect.Effect<Option.Option<string>, McpFailure> => {
    const trimmed = Str.trim(payload);

    if (!Str.startsWith('{')(trimmed)) return Effect.succeedNone;

    return decodeMcpPayload(trimmed).pipe(
        Effect.map(firstText),
        Effect.mapError((error) =>
            McpFailure.make({ message: `Failed to parse web search response: ${error.message}` }),
        ),
    );
};

const parseMcpResponse = (body: string): Effect.Effect<Option.Option<string>, McpFailure> =>
    Effect.gen(function* () {
        const direct = yield* parsePayload(body);

        if (Option.isSome(direct)) return direct;

        for (const line of Str.split(body, '\n')) {
            if (!Str.startsWith('data: ')(line)) continue;
            const text = yield* parsePayload(Str.slice(6)(line));

            if (Option.isSome(text)) return text;
        }

        return Option.none();
    });

const callMcp = (input: {
    readonly url: string;
    readonly tool: string;
    readonly arguments: Record<string, Schema.Json>;
    readonly headers?: Record<string, string>;
    readonly timeoutMs: number;
}): Effect.Effect<Option.Option<string>, McpFailure, HttpClient.HttpClient> =>
    Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(input.url, {
            headers: { accept: 'application/json, text/event-stream', ...input.headers },
        }).pipe(
            HttpClientRequest.schemaBodyJson(McpToolCall)({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: input.tool, arguments: input.arguments },
            }),
        );

        const response = yield* HttpClient.execute(request);

        if (response.status < 200 || response.status >= 300) {
            return yield* McpFailure.make({
                message: `${input.tool} request failed with status code: ${response.status}`,
            });
        }

        return yield* parseMcpResponse(yield* response.text);
    }).pipe(
        Effect.catchTags({
            HttpBodyError: (error) =>
                Effect.fail(McpFailure.make({ message: `Failed to encode web search request (${error.reason._tag})` })),
            HttpClientError: (error) => Effect.fail(McpFailure.make({ message: error.message })),
        }),
        Effect.timeoutOrElse({
            duration: Duration.millis(input.timeoutMs),
            orElse: () => Effect.fail(McpFailure.make({ message: `${input.tool} request timed out` })),
        }),
    );

export const webSearchTool = (options: WebSearchToolOptions | undefined): FoldTool<HttpClient.HttpClient> =>
    defineTool({
        ...webSearchToolContract,
        handler: (params) =>
            Effect.gen(function* () {
                const currentAgent = yield* CurrentAgent;
                const provider = selectProvider(currentAgent.agentId, options);
                const numResults = Math.min(params.numResults ?? 8, maxNumResults);
                const contextMaxCharacters = Math.min(params.contextMaxCharacters ?? 10_000, maxContextCharacters);

                const timeoutMs =
                    params.timeout_seconds === undefined
                        ? (options?.timeoutMs ?? defaultTimeoutMs)
                        : params.timeout_seconds * 1000;

                const result =
                    provider === 'exa'
                        ? yield* callMcp({
                              url: resolveExaUrl(options),
                              tool: 'web_search_exa',
                              arguments: {
                                  query: params.query,
                                  type: params.type ?? 'auto',
                                  numResults,
                                  livecrawl: params.livecrawl ?? 'fallback',
                                  contextMaxCharacters,
                              },
                              timeoutMs,
                          })
                        : yield* callMcp({
                              url: parallelUrl,
                              tool: 'web_search',
                              arguments: {
                                  objective: params.query,
                                  search_queries: [params.query],
                              },
                              headers: resolveParallelHeaders(options),
                              timeoutMs,
                          });

                return ToolResultText.make({
                    text: Option.getOrElse(result, () => 'No search results found. Please try a different query.'),
                });
            }).pipe(Effect.mapError((error) => ToolResultFailure.make({ text: error.message }))),
    });
