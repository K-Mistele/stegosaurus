import { SessionId } from '@stegosaurus/fold-core';
import { Clock, Effect, FileSystem, Option, Path, Schema, String as Str } from 'effect';

import { sessionsDirFor, type SessionLayoutOptions } from './SessionLayout';

const ViewedChangeRecord = Schema.Struct({
    sessionId: SessionId,
    changeKey: Schema.String,
    patchHash: Schema.String,
    ts: Schema.Finite,
});

const ViewedChangeLine = Schema.fromJsonString(ViewedChangeRecord);

const decodeViewedChangeLine = Schema.decodeUnknownOption(ViewedChangeLine);

const encodeViewedChangeLine = Schema.encodeEffect(ViewedChangeLine);

export type ViewedPatchHashes = Readonly<Record<string, string>>;

const viewedChangesPath = (path: Path.Path, options: SessionLayoutOptions | undefined): string =>
    path.join(sessionsDirFor(options), 'viewed-changes.jsonl');

export const loadViewedPatchHashes = (
    sessionId: SessionId,
    options: SessionLayoutOptions | undefined,
): Effect.Effect<ViewedPatchHashes, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        return yield* fs.readFileString(viewedChangesPath(path, options)).pipe(
            Effect.map((contents) => {
                const viewed: Record<string, string> = {};

                for (const line of Str.split(contents, '\n')) {
                    if (Str.trim(line).length === 0) continue;
                    // A partial record does not invalidate the rest of this derived UI index.
                    const record = decodeViewedChangeLine(line);

                    if (Option.isSome(record) && record.value.sessionId === sessionId) {
                        viewed[record.value.changeKey] = record.value.patchHash;
                    }
                }

                return viewed;
            }),
            Effect.orElseSucceed(() => ({})),
        );
    });

export const saveViewedPatchHash = (
    sessionId: SessionId,
    changeKey: string,
    patchHash: string,
    options: SessionLayoutOptions | undefined,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = sessionsDirFor(options);
        const ts = yield* Clock.currentTimeMillis;
        const line = yield* encodeViewedChangeLine({ sessionId, changeKey, patchHash, ts });
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(viewedChangesPath(path, options), `${line}\n`, { flag: 'a' });
    }).pipe(
        Effect.catch((error) =>
            Effect.logWarning(`could not save viewed change for session ${sessionId}: ${error.message}`),
        ),
    );
