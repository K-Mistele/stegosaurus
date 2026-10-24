/**
 * File-backed OutputStore for large tool output (D19): one deterministic text file per tool call,
 * `<directory>/<toolCallId>.txt`. A launched session uses `<foldHome>/tool-output/<sessionId>`; the host
 * provides the store where it starts the session and the bash tool asks for it. The durable log keeps
 * the truncated result the model saw; this store is retrieval-only supporting data, streamed from the
 * first byte so interrupted commands still leave partial output behind.
 */
import { join } from 'node:path';

import { ToolCallId, type SessionId } from '@stegosaurus/fold-core';
import {
    Array as Arr,
    Cause,
    Clock,
    Context,
    Effect,
    FileSystem,
    Layer,
    Option,
    Path,
    Schema,
    String as Str,
} from 'effect';

import { defaultFoldHome } from '../Config/Load';

const dayMs = 24 * 60 * 60 * 1000;

/** Reference to one stored tool-output file. */
export class OutputStoreRef extends Schema.Class<OutputStoreRef, { readonly brand: unique symbol }>(
    'fold-agent/OutputStoreRef',
)({
    toolCallId: ToolCallId,
    path: Schema.String,
}) {}

/** File-backed OutputStore operation failure. */
export class OutputStoreError extends Schema.TaggedError<OutputStoreError, { readonly brand: unique symbol }>()(
    'OutputStoreError',
    {
        operation: Schema.Literals(['prepare', 'append', 'read']),
        path: Schema.String,
        message: Schema.String,
        cause: Schema.optional(Schema.Defect()),
    },
) {}

/** Options for reading a stored output file. */
export type OutputStoreReadOptions = {
    /** 1-indexed line offset. Defaults to the first line. */
    readonly offset?: number;
    /** Maximum number of lines to return. Defaults to the remainder of the file. */
    readonly limit?: number;
};

/** Deep service surface for deterministic tool-output storage. */
export type OutputStoreService = {
    /** Directory containing the tool-output files. */
    readonly directory: string;
    /** Compute the deterministic reference for one tool call without touching disk. */
    readonly refFor: (toolCallId: ToolCallId) => OutputStoreRef;
    /** Ensure the output file exists and return its reference. */
    readonly prepare: (toolCallId: ToolCallId) => Effect.Effect<OutputStoreRef, OutputStoreError>;
    /** Append one chunk to the output file, creating it if needed. */
    readonly append: (toolCallId: ToolCallId, chunk: string) => Effect.Effect<OutputStoreRef, OutputStoreError>;
    /** Read output back for retrieval/debug surfaces. */
    readonly read: (ref: OutputStoreRef, options?: OutputStoreReadOptions) => Effect.Effect<string, OutputStoreError>;
};

/** Where tools store their full output. The host provides it; the bash tool asks for it. */
export class OutputStore extends Context.Service<OutputStore, OutputStoreService>()(
    '@stegosaurus/fold-agent/OutputStore/OutputStore',
) {}

/** Root directory for all stored tool output. */
export const toolOutputRootFor = (options: { readonly foldHome?: string } | undefined): string =>
    join(options?.foldHome ?? defaultFoldHome(), 'tool-output');

/** Directory for one session's stored tool output. */
export const toolOutputSessionDirFor = (input: { readonly sessionId: SessionId; readonly foldHome?: string }): string =>
    join(toolOutputRootFor(input), input.sessionId);

/** Deterministic path for one tool call's full output. */
export const toolOutputPathFor = (input: {
    readonly sessionId: SessionId;
    readonly toolCallId: ToolCallId;
    readonly foldHome?: string;
}): string => join(toolOutputSessionDirFor(input), `${input.toolCallId}.txt`);

const fileOperationError = (input: {
    readonly operation: 'prepare' | 'append' | 'read';
    readonly path: string;
    readonly cause: unknown;
}): OutputStoreError =>
    OutputStoreError.make({
        operation: input.operation,
        path: input.path,
        message: `OutputStore ${input.operation} failed for ${input.path}: ${String(input.cause)}`,
        cause: input.cause,
    });

const logStoreError = (error: OutputStoreError): Effect.Effect<void> =>
    Effect.logWarning(error.message).pipe(Effect.annotateLogs({ operation: error.operation, path: error.path }));

const lineSlice = (content: string, options: OutputStoreReadOptions | undefined): string => {
    const offset = Math.max(1, options?.offset ?? 1);
    const start = offset - 1;
    const limit = options?.limit;

    if (limit === undefined) return Arr.join(Str.split(content, '\n').slice(start), '\n');

    return Arr.join(Str.split(content, '\n').slice(start, start + Math.max(0, limit)), '\n');
};

/** A file-backed OutputStore writing one file per tool call into `directory`. */
export const layerOutputStore = (options: {
    readonly directory: string;
}): Layer.Layer<OutputStore, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
        OutputStore,
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const pathService = yield* Path.Path;
            const directory = options.directory;

            const refFor = (toolCallId: ToolCallId): OutputStoreRef =>
                OutputStoreRef.make({ toolCallId, path: pathService.join(directory, `${toolCallId}.txt`) });

            const prepare = (toolCallId: ToolCallId): Effect.Effect<OutputStoreRef, OutputStoreError> => {
                const ref = refFor(toolCallId);

                return fs.makeDirectory(directory, { recursive: true }).pipe(
                    Effect.andThen(fs.writeFileString(ref.path, '', { flag: 'a' })),
                    Effect.as(ref),
                    Effect.mapError((cause) => fileOperationError({ operation: 'prepare', path: ref.path, cause })),
                    Effect.tapError(logStoreError),
                    Effect.withSpan('output_store.prepare', { attributes: { toolCallId, path: ref.path } }),
                );
            };

            const append = (toolCallId: ToolCallId, chunk: string): Effect.Effect<OutputStoreRef, OutputStoreError> => {
                const ref = refFor(toolCallId);

                return fs.makeDirectory(directory, { recursive: true }).pipe(
                    Effect.andThen(fs.writeFileString(ref.path, chunk, { flag: 'a' })),
                    Effect.as(ref),
                    Effect.mapError((cause) => fileOperationError({ operation: 'append', path: ref.path, cause })),
                    Effect.tapError(logStoreError),
                    Effect.withSpan('output_store.append', {
                        attributes: { toolCallId, path: ref.path, bytes: chunk.length },
                    }),
                );
            };

            const read = (
                ref: OutputStoreRef,
                readOptions: OutputStoreReadOptions | undefined,
            ): Effect.Effect<string, OutputStoreError> =>
                fs.readFileString(ref.path).pipe(
                    Effect.map((content) => lineSlice(content, readOptions)),
                    Effect.mapError((cause) => fileOperationError({ operation: 'read', path: ref.path, cause })),
                    Effect.tapError(logStoreError),
                    Effect.withSpan('output_store.read', {
                        attributes: { toolCallId: ref.toolCallId, path: ref.path },
                    }),
                );

            return { directory, refFor, prepare, append, read };
        }),
    );

/**
 * Best-effort retention sweep over every session's stored output under `<foldHome>/tool-output`: files
 * older than `retentionMs` (default 7 days) are deleted. It logs and swallows failures.
 */
export const sweepToolOutput = (
    options: { readonly foldHome?: string; readonly retentionMs?: number } | undefined,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const root = toolOutputRootFor(options);
        const retentionMs = options?.retentionMs ?? 7 * dayMs;
        const now = yield* Clock.currentTimeMillis;
        const sessions = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));

        for (const sessionName of sessions) {
            const sessionDir = pathService.join(root, sessionName);
            const files = yield* fs.readDirectory(sessionDir).pipe(Effect.orElseSucceed(() => []));

            for (const file of files) {
                if (!Str.endsWith('.txt')(file)) continue;
                const path = pathService.join(sessionDir, file);
                const info = yield* fs.stat(path).pipe(Effect.orElseSucceed(() => null));

                if (info === null || info.type !== 'File') continue;

                const mtime = Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });

                if (now - mtime > retentionMs) yield* fs.remove(path).pipe(Effect.ignore);
            }
        }
    }).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`OutputStore sweep failed: ${Cause.pretty(cause)}`)),
        Effect.withSpan('output_store.sweep'),
    );
