/**
 * Effect's `FileSystem` over a session's Computer, so fold's file tools and skill loader work on the
 * workspace unchanged. It covers what they call: reading, writing, making directories, removing,
 * `stat`, `access`, `exists`, `realPath` and listing a directory, and appending, which fold's output store
 * does. Every other method is Effect's no-op.
 *
 * The workspace has no permissions, so `access` only checks the path exists. It has symlinks, but
 * `realPath` returns the path unchanged: fold only uses it to key its per-file write lock.
 */
import type { RpcCallError } from 'alchemy';
import { ByteSize, DateTime, Effect, FileSystem, Option, PlatformError, String as Str } from 'effect';

import type { FileInfo } from './computer/Contract';
import { thrownComputerError } from './ComputerError';

/** The Computer's file methods, as its RPC stub returns them. A failure carries what the Computer threw. */
export type ComputerFiles = {
    readonly readFile: (path: string) => Effect.Effect<Uint8Array, RpcCallError>;
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, RpcCallError>;
    readonly mkdir: (path: string, recursive: boolean) => Effect.Effect<void, RpcCallError>;
    readonly rm: (path: string, recursive: boolean, force: boolean) => Effect.Effect<void, RpcCallError>;
    readonly stat: (path: string) => Effect.Effect<FileInfo, RpcCallError>;
    readonly readdir: (path: string) => Effect.Effect<ReadonlyArray<string>, RpcCallError>;
};

const SYSTEM_ERROR_TAGS = new Map<string, PlatformError.SystemErrorTag>([
    ['ENOENT', 'NotFound'],
    ['EEXIST', 'AlreadyExists'],
    ['EACCES', 'PermissionDenied'],
    ['EPERM', 'PermissionDenied'],
    ['EISDIR', 'BadResource'],
    ['ENOTDIR', 'BadResource'],
    ['EINVAL', 'InvalidData'],
]);

/**
 * A failed workspace file call, as the `FileSystem` error fold's tools read. Its kind comes from the thrown
 * error's `code`, which stays in `cause.code` beside the path and system call. The description is the
 * Computer's own message, such as `ENOENT: no such file or directory, open '/workspace/repo/x.ts'`, so the
 * model sees all of it. A call that failed before reaching the Computer, or an unknown code, is `Unknown`:
 * the tool call fails and the session goes on.
 */
const workspaceFileError = (method: string, path: string, error: RpcCallError) =>
    Option.match(thrownComputerError(error), {
        onNone: () =>
            PlatformError.systemError({
                _tag: 'Unknown',
                module: 'FileSystem',
                method,
                pathOrDescriptor: path,
                description: error.message,
                cause: error,
            }),
        onSome: (thrown) =>
            PlatformError.systemError({
                _tag: (thrown.code === undefined ? undefined : SYSTEM_ERROR_TAGS.get(thrown.code)) ?? 'Unknown',
                module: 'FileSystem',
                method,
                pathOrDescriptor: thrown.path ?? path,
                syscall: thrown.syscall,
                description: thrown.message,
                cause: thrown,
            }),
    });

/** One Computer call as an Effect, failing with the `FileSystem` error for what the Computer threw. */
const run = <A>(
    method: string,
    path: string,
    call: Effect.Effect<A, RpcCallError>,
): Effect.Effect<A, PlatformError.PlatformError> =>
    call.pipe(
        Effect.mapError((error) => workspaceFileError(method, path, error)),
        Effect.tap(() => Effect.logInfo('workspace.file').pipe(Effect.annotateLogs({ method, path, outcome: 'ok' }))),
        Effect.tapError((error) =>
            Effect.logInfo('workspace.file').pipe(
                Effect.annotateLogs({ method, path, outcome: error.reason._tag, error: error.message }),
            ),
        ),
    );

const toInfo = (info: FileInfo): FileSystem.File.Info => ({
    type: info.type,
    mtime: Option.map(DateTime.make(info.mtime), DateTime.toDateUtc),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 0n,
    ino: Option.some(BigInt(info.inode)),
    mode: info.mode,
    nlink: Option.none(),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: ByteSize.bytes(info.size),
    blksize: Option.none(),
    blocks: Option.none(),
});

/** The workspace as a `FileSystem`, over `computer`, which looks up the session's Computer. */
export const workspaceFileSystem = (computer: Effect.Effect<ComputerFiles>): FileSystem.FileSystem => {
    const stat = (path: string) =>
        run(
            'stat',
            path,
            Effect.flatMap(computer, (files) => files.stat(path)),
        ).pipe(Effect.map(toInfo));

    const readFile = (path: string) =>
        run(
            'readFile',
            path,
            Effect.flatMap(computer, (files) => files.readFile(path)),
        );

    return FileSystem.makeNoop({
        readFile,
        readFileString: (path, encoding) =>
            Effect.flatMap(readFile(path), (bytes) =>
                Effect.try({
                    try: () => new TextDecoder(encoding).decode(bytes),
                    catch: (cause) =>
                        PlatformError.badArgument({
                            module: 'FileSystem',
                            method: 'readFileString',
                            description: 'invalid encoding',
                            cause,
                        }),
                }),
            ),
        /** The workspace has no append, so appending (flag `a`) rewrites the file with `data` added. */
        writeFileString: (path, data, options) =>
            Effect.gen(function* () {
                const flag = options?.flag;

                const existing =
                    flag !== undefined && Str.startsWith('a')(flag)
                        ? yield* readFile(path).pipe(
                              Effect.map((bytes) => new TextDecoder().decode(bytes)),
                              Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed('')),
                          )
                        : '';

                yield* run(
                    'writeFileString',
                    path,
                    Effect.flatMap(computer, (files) => files.writeFile(path, existing + data)),
                );
            }),
        makeDirectory: (path, options) =>
            run(
                'makeDirectory',
                path,
                Effect.flatMap(computer, (files) => files.mkdir(path, options?.recursive ?? false)),
            ),
        remove: (path, options) =>
            run(
                'remove',
                path,
                Effect.flatMap(computer, (files) =>
                    files.rm(path, options?.recursive ?? false, options?.force ?? false),
                ),
            ),
        stat,
        access: (path) => stat(path),
        exists: (path) =>
            stat(path).pipe(
                Effect.as(true),
                Effect.catchReasons('PlatformError', { NotFound: () => Effect.succeed(false) }),
            ),
        realPath: (path) => Effect.as(stat(path), path),
        readDirectory: (path, options) =>
            options?.recursive === true
                ? Effect.fail(
                      PlatformError.badArgument({
                          module: 'FileSystem',
                          method: 'readDirectory',
                          description: 'recursive listing is not supported',
                      }),
                  )
                : run(
                      'readDirectory',
                      path,
                      Effect.flatMap(computer, (files) => files.readdir(path)),
                  ).pipe(Effect.map((names) => [...names])),
    });
};
