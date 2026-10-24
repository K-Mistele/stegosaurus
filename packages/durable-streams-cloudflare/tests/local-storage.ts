import * as Alchemy from 'alchemy';
import { Effect, FileSystem, Path } from 'effect';

/**
 * Destroys the local Stack, then deletes the Durable Object storage its Worker wrote under
 * `.alchemy/local/<worker>-StreamObject`. Destroying a local Worker stops workerd but leaves that
 * directory, and the tests write a new stream path on every run, so it grows without bound.
 */
export const destroyWithStorage = <E, R, E2, R2>(
    stack: Effect.Effect<{ readonly workerName: string }, E, R>,
    destroyStack: Effect.Effect<unknown, E2, R2>,
) =>
    Effect.gen(function* () {
        const { workerName } = yield* stack;
        const { dotAlchemy } = yield* Alchemy.AlchemyContext;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* destroyStack;

        yield* fs.remove(path.join(dotAlchemy, 'local', encodeURIComponent(`${workerName}-StreamObject`)), {
            recursive: true,
            force: true,
        });
    });
