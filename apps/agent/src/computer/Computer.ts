/**
 * The Computer Durable Object: one `@cloudflare/computer` Workspace per AgentSession Durable Object, using
 * the same object name. The Workspace is a virtual filesystem in the object's SQLite, with git, and two places to run
 * commands on it:
 *
 * - `shell`: just-bash in a Worker the Worker Loader starts, which reads and writes this same filesystem.
 * - `container`: this object's Linux container (see `Dockerfile`), running `computerd`, which mounts a copy
 *   of the filesystem at `/workspace`. Each command first sends the container the files changed since the
 *   last one, then copies back what the command changed.
 *
 * A plain Durable Object rather than an Effect one, because `withWorkspace` must wrap the
 * `cloudflare:workers` class. Each RPC method runs an Effect and answers with its promise. A failure rejects
 * with exactly what the workspace threw, so Workers RPC carries its `code` and other fields to the caller.
 */
import { getWorkspace, type TruncatedOutput, type WorkspaceClient, withWorkspace } from '@cloudflare/computer';
import { ContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container';
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell';
import { createGitClient, type GitClient } from '@cloudflare/computer/git';
import jq from '@cloudflare/computer/shell/jq';
import { DurableObject } from 'cloudflare:workers';
import { Array as Arr, Duration, Effect, Record as Rec, Schema, type Scope, String as Str } from 'effect';

import {
    type Backend,
    type CommandInput,
    type CommandOutput,
    COMMAND_OUTPUT_LIMITS,
    COMPUTER_BINDING,
    COMPUTER_CONTAINER_IMAGE,
    type FetchedBranch,
    type FileInfo,
    GIT_IDENTITY,
    type GitHeaders,
    type MergedRef,
    type PreparedRepo,
    type PrepareRepoInput,
    type PulledRepo,
    type PushedBranch,
    TOOL_OUTPUT_DIRECTORY,
    type TruncatedStream,
    WORKSPACE_ROOT,
} from './Contract';

/**
 * Entrypoints the backends reach this object through, via `ctx.exports`: the shell calls back into the
 * workspace through WorkspaceServiceProxy, and the container dials its connection in through WorkspaceProxy.
 */
export { WorkspaceProxy, WorkspaceServiceProxy } from '@cloudflare/computer';

type Env = {
    /** Starts the shell's Worker. */
    readonly LOADER: WorkerLoader;
};

/** How long `startContainer` waits for the no-op command, past the container's own 30s start budget. */
const CONTAINER_START_TIMEOUT_MILLIS = 10_000;

/** How long `destroy` waits after answering before the object restarts. */
const RESTART_DELAY = Duration.seconds(1);

/** What a workspace call threw: an error with a `code` such as `ENOENT`, or git's error. */
class WorkspaceThrew extends Schema.TaggedError<WorkspaceThrew, { readonly brand: unique symbol }>()('WorkspaceThrew', {
    thrown: Schema.Defect(),
}) {}

/** One call into the workspace or its git client. */
const workspaceCall = <A>(operation: () => PromiseLike<A>) =>
    Effect.tryPromise({ try: () => operation(), catch: (thrown) => WorkspaceThrew.make({ thrown }) });

/** Fail as if the workspace had thrown an error with this message. */
const workspaceFailure = (message: string) => WorkspaceThrew.make({ thrown: new Error(message) });

/** Answer an RPC method. A failure rejects with what the workspace threw, unchanged. */
const answer = <A>(effect: Effect.Effect<A, WorkspaceThrew, Scope.Scope>): Promise<A> =>
    Effect.runPromise(
        effect.pipe(
            Effect.scoped,
            Effect.catchTag('WorkspaceThrew', ({ thrown }) => Effect.die(thrown)),
        ),
    );

/** The object's own Workspace, released when the method's scope closes. */
const workspaceOf = (host: Computer): Effect.Effect<WorkspaceClient, WorkspaceThrew, Scope.Scope> =>
    Effect.acquireDisposable(workspaceCall(() => getWorkspace(host)));

/** The workspace's git client, which `@cloudflare/computer` types loosely across local and remote use. */
const gitOf = (workspace: WorkspaceClient): GitClient => workspace.git;

/** Replace each header value in `text`, so a credential in an error message goes no further. */
const scrub = (text: string, headers: GitHeaders) =>
    Arr.reduce(Rec.values(headers), text, (scrubbed, value) => Str.replaceAll(value, '[redacted]')(scrubbed));

/** The part of a thrown error that may quote a request, such as git's URL and headers. */
const ThrownMessage = Schema.Struct({ message: Schema.String });

const isThrownMessage = Schema.is(ThrownMessage);

/**
 * Scrub a git network operation's headers from any failure's message. The thrown error keeps its other
 * fields, such as `code`.
 */
const scrubbingHeaders =
    (headers: GitHeaders) =>
    <A, R>(effect: Effect.Effect<A, WorkspaceThrew, R>) =>
        Effect.mapError(effect, ({ thrown }) =>
            WorkspaceThrew.make({
                thrown: isThrownMessage(thrown)
                    ? Object.assign(thrown, { message: scrub(thrown.message, headers) })
                    : new Error(scrub(String(thrown), headers)),
            }),
        );

const repoDir = (name: string) => `${WORKSPACE_ROOT}/${name}`;

/** The remote has no such ref: isomorphic-git's `NotFoundError`, wrapped in the git client's error. */
const RefNotFound = Schema.Struct({ cause: Schema.Struct({ code: Schema.Literal('NotFoundError') }) });

const isRefNotFound = Schema.is(RefNotFound);

const currentBranchOf = (git: GitClient, dir: string) =>
    workspaceCall(() => git.currentBranch({ dir })).pipe(
        Effect.filterOrFail(
            (branch): branch is string => branch !== undefined,
            () => workspaceFailure(`${dir} has no branch checked out`),
        ),
    );

const revParse = (git: GitClient, dir: string, ref: string) => workspaceCall(() => git.revParse({ dir, ref }));

/** Make `git pull` on `branch` pull the remote branch of the same name. */
const trackOrigin = (git: GitClient, dir: string, branch: string) =>
    Effect.gen(function* () {
        yield* workspaceCall(() => git.configSet({ dir, path: `branch.${branch}.remote`, value: 'origin' }));
        yield* workspaceCall(() =>
            git.configSet({ dir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` }),
        );
    });

const pushToOrigin = (git: GitClient, dir: string, branch: string, headers: GitHeaders) =>
    workspaceCall(() =>
        git.push({ dir, remote: 'origin', ref: branch, remoteRef: branch, headers: { ...headers } }),
    ).pipe(
        Effect.flatMap((result) =>
            result.ok
                ? Effect.void
                : Effect.fail(
                      workspaceFailure(`git push of ${branch} was rejected: ${result.error ?? 'no reason given'}`),
                  ),
        ),
    );

/** Fetch `branch` from the remote; false when the remote has no such branch. */
const fetchIfPresent = (git: GitClient, dir: string, branch: string, headers: GitHeaders) =>
    workspaceCall(() =>
        git.fetch({ dir, remote: 'origin', ref: branch, singleBranch: true, headers: { ...headers } }),
    ).pipe(
        Effect.as(true),
        Effect.catchIf(
            ({ thrown }) => isRefNotFound(thrown),
            () => Effect.succeed(false),
        ),
    );

/** Check out the work branch: the remote's when it has one, otherwise a new one, pushed. Whether it was new. */
const checkOutWorkBranch = (git: GitClient, dir: string, branch: string, headers: GitHeaders) =>
    Effect.gen(function* () {
        const remoteHasBranch = yield* fetchIfPresent(git, dir, branch, headers);

        if (remoteHasBranch) {
            yield* workspaceCall(() => git.branch({ dir, name: branch, startPoint: `refs/remotes/origin/${branch}` }));
            yield* workspaceCall(() => git.checkout({ dir, ref: branch, force: true }));
        } else {
            yield* workspaceCall(() => git.branch({ dir, name: branch, checkout: true }));
            yield* pushToOrigin(git, dir, branch, headers);
        }

        yield* trackOrigin(git, dir, branch);

        return !remoteHasBranch;
    });

/** Clone the repo and check out its work branch; see `Computer.prepare`. */
const prepareRepo = (workspace: WorkspaceClient, input: PrepareRepoInput) =>
    Effect.gen(function* () {
        const git = gitOf(workspace);
        const dir = repoDir(input.name);

        yield* workspaceCall(() => workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true }));
        yield* workspaceCall(() => workspace.fs.rm(dir, { recursive: true, force: true }));
        yield* workspaceCall(() => git.clone({ url: input.url, dir, headers: { ...input.headers } }));

        const defaultBranch = yield* currentBranchOf(git, dir);

        yield* workspaceCall(() => git.configSet({ dir, path: 'user.name', value: GIT_IDENTITY.name }));
        yield* workspaceCall(() => git.configSet({ dir, path: 'user.email', value: GIT_IDENTITY.email }));

        const workBranch = input.branch === null || input.branch === defaultBranch ? null : input.branch;

        const createdBranch =
            workBranch === null ? false : yield* checkOutWorkBranch(git, dir, workBranch, input.headers);

        return {
            dir,
            branch: input.branch ?? defaultBranch,
            defaultBranch,
            commit: yield* revParse(git, dir, 'HEAD'),
            createdBranch,
        } satisfies PreparedRepo;
    });

/** One stream's truncation as the Contract carries it. */
const truncatedStream = (truncated: TruncatedOutput | undefined): TruncatedStream | null => {
    if (truncated === undefined) return null;

    return {
        path: truncated.status === 'saved' ? truncated.path : null,
        notSavedReason: truncated.status === 'saved' ? null : truncated.reason,
        totalLines: truncated.totalLines,
        firstLine: truncated.firstLine,
    };
};

/**
 * The container half of the object. The backends live here rather than on Computer because withWorkspace's
 * options callback reads them while it builds the Workspace: base-class fields are set by then, subclass
 * fields are not.
 */
class ComputerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
    /**
     * For withWorkspace's options, which see the instance but not `ctx` or `env`: DurableObject keeps them
     * protected.
     */
    readonly storage = this.ctx.storage;

    readonly shell = new WorkerShellBackend({
        id: 'shell' satisfies Backend,
        loader: this.env.LOADER,
        workspace: { binding: COMPUTER_BINDING, id: this.ctx.id.toString() },
        ctx: this.ctx,
        commands: [jq],
    });

    /**
     * The object schedules its own container (`schedulingPolicy: "durable_object"`), so it names the image and
     * the instance size here. Dependencies stay on the container's disk, out of the workspace.
     */
    readonly container = new ContainerBackend({
        id: 'container' satisfies Backend,
        container: () => this,
        workspace: { binding: COMPUTER_BINDING, id: this.ctx.id.toString() },
        /** Commands may install packages. */
        egress: { mode: 'direct' },
        name: COMPUTER_CONTAINER_IMAGE,
        instance: 'standard-4',
        ignore: ['**/node_modules'],
    });
}

export class Computer extends withWorkspace(ComputerBase, (self) => ({
    storage: self.storage,
    git: createGitClient(),
    backends: [self.shell, self.container],
    output: { ...COMMAND_OUTPUT_LIMITS, dir: TOOL_OUTPUT_DIRECTORY },
})) {
    /** The container's connection, which `computerd` dials in through WorkspaceProxy. */
    override fetch(request: Request): Promise<Response> {
        return this.container.handleFetch(request);
    }

    /**
     * Start the container and connect to it, so the first container command doesn't wait for it. Runs a
     * no-op command: the workspace connects a backend on its first command.
     */
    startContainer(): Promise<void> {
        return answer(
            Effect.flatMap(
                this.run({
                    backend: 'container',
                    command: 'true',
                    cwd: '/',
                    timeoutMs: CONTAINER_START_TIMEOUT_MILLIS,
                }),
                () => Effect.void,
            ),
        );
    }

    /**
     * Clone the repo into `/workspace/<name>`, replacing whatever a cut-off earlier attempt left there, and
     * check out the branch to work on. A branch the remote has is checked out from it; a new one is made
     * from the default branch and pushed, so the remote has it from the start.
     */
    prepare(input: PrepareRepoInput): Promise<PreparedRepo> {
        return answer(
            workspaceOf(this).pipe(
                Effect.flatMap((workspace) => prepareRepo(workspace, input)),
                scrubbingHeaders(input.headers),
            ),
        );
    }

    /**
     * Fast-forward the current branch of `/workspace/<name>` to its remote branch, so the agent sees commits
     * pushed since it was cloned. Fails rather than merge, such as when local commits or edits are in the way.
     */
    pull(input: { readonly name: string; readonly headers: GitHeaders }): Promise<PulledRepo> {
        return answer(
            Effect.gen({ self: this }, function* () {
                const git = gitOf(yield* workspaceOf(this));
                const dir = repoDir(input.name);
                const before = yield* revParse(git, dir, 'HEAD');

                yield* workspaceCall(() => git.pull({ dir, fastForwardOnly: true, headers: { ...input.headers } }));

                return { before, after: yield* revParse(git, dir, 'HEAD') };
            }).pipe(scrubbingHeaders(input.headers)),
        );
    }

    /** Fetch the remote's `branch` into `origin/<branch>`, leaving the working tree alone. */
    fetchBranch(input: {
        readonly name: string;
        readonly branch: string;
        readonly headers: GitHeaders;
    }): Promise<FetchedBranch> {
        return answer(
            Effect.gen({ self: this }, function* () {
                const git = gitOf(yield* workspaceOf(this));
                const dir = repoDir(input.name);

                yield* workspaceCall(() =>
                    git.fetch({
                        dir,
                        remote: 'origin',
                        ref: input.branch,
                        singleBranch: true,
                        headers: { ...input.headers },
                    }),
                );

                return {
                    branch: input.branch,
                    commit: yield* revParse(git, dir, `refs/remotes/origin/${input.branch}`),
                };
            }).pipe(scrubbingHeaders(input.headers)),
        );
    }

    /** Push `branch` to the remote branch of the same name. Fails unless `branch` is checked out. */
    pushBranch(input: {
        readonly name: string;
        readonly branch: string;
        readonly headers: GitHeaders;
    }): Promise<PushedBranch> {
        return answer(
            Effect.gen({ self: this }, function* () {
                const git = gitOf(yield* workspaceOf(this));
                const dir = repoDir(input.name);
                const current = yield* workspaceCall(() => git.currentBranch({ dir }));

                if (current !== input.branch) {
                    return yield* workspaceFailure(
                        `The checked-out branch is ${current ?? 'none (detached HEAD)'}, not ${input.branch}.`,
                    );
                }

                yield* pushToOrigin(git, dir, input.branch, input.headers);

                return { branch: input.branch, commit: yield* revParse(git, dir, 'HEAD') };
            }).pipe(scrubbingHeaders(input.headers)),
        );
    }

    /**
     * Merge `ref`, such as `origin/main`, into the current branch, fast-forwarding when it can, and update the
     * working tree to the result. Refuses while tracked files have uncommitted changes. A conflict aborts the
     * merge and leaves everything as it was.
     */
    mergeRef(input: { readonly name: string; readonly ref: string }): Promise<MergedRef> {
        return answer(
            Effect.gen({ self: this }, function* () {
                const git = gitOf(yield* workspaceOf(this));
                const dir = repoDir(input.name);
                const status = yield* workspaceCall(() => git.status({ dir }));
                const changed = Arr.filter(status, (entry) => entry.worktree !== '?');

                if (Arr.isReadonlyArrayNonEmpty(changed)) {
                    const paths = Arr.join(
                        Arr.map(changed, (entry) => entry.path),
                        ', ',
                    );

                    return yield* workspaceFailure(`Commit or discard the changes to ${paths} before merging.`);
                }

                const branch = yield* currentBranchOf(git, dir);
                const result = yield* workspaceCall(() => git.merge({ dir, theirs: input.ref }));

                yield* workspaceCall(() => git.checkout({ dir, ref: branch, force: true }));

                return {
                    commit: yield* revParse(git, dir, 'HEAD'),
                    fastForward: result.fastForward === true,
                    alreadyMerged: result.alreadyMerged === true,
                };
            }),
        );
    }

    /**
     * The file methods fold's read, write, edit and apply_patch tools and its skill loader need. Paths are
     * absolute. A failure throws the workspace's own error, with its `code` (`ENOENT`, ...) and message.
     */

    readFile(path: string): Promise<Uint8Array> {
        return answer(
            workspaceOf(this).pipe(
                Effect.flatMap((workspace) => workspaceCall(() => workspace.fs.readFile(path))),
                Effect.flatMap((content) => workspaceCall(() => new Response(content).bytes())),
            ),
        );
    }

    writeFile(path: string, content: string): Promise<void> {
        return answer(
            workspaceOf(this).pipe(
                Effect.flatMap((workspace) => workspaceCall(() => workspace.fs.writeFile(path, content))),
            ),
        );
    }

    mkdir(path: string, recursive: boolean): Promise<void> {
        return answer(
            workspaceOf(this).pipe(
                Effect.flatMap((workspace) => workspaceCall(() => workspace.fs.mkdir(path, { recursive }))),
            ),
        );
    }

    rm(path: string, recursive: boolean, force: boolean): Promise<void> {
        return answer(
            workspaceOf(this).pipe(
                Effect.flatMap((workspace) => workspaceCall(() => workspace.fs.rm(path, { recursive, force }))),
            ),
        );
    }

    /** Follows symlinks. */
    stat(path: string): Promise<FileInfo> {
        return answer(
            workspaceOf(this).pipe(
                Effect.flatMap((workspace) => workspaceCall(() => workspace.fs.stat(path))),
                Effect.map((stat) => ({
                    type: stat.isDirectory ? 'Directory' : stat.isSymbolicLink ? 'SymbolicLink' : 'File',
                    size: stat.size,
                    mtime: stat.mtime,
                    mode: stat.mode,
                    inode: stat.inode,
                })),
            ),
        );
    }

    /** The directory's entry names. */
    readdir(path: string): Promise<ReadonlyArray<string>> {
        return answer(
            workspaceOf(this).pipe(
                Effect.flatMap((workspace) => workspaceCall(() => workspace.fs.readdir(path))),
                Effect.map((entries) => Arr.map(entries, (entry) => entry.name)),
            ),
        );
    }

    /**
     * Delete this workspace at `deleteAt` (epoch milliseconds) unless moved again before then. Its session
     * normally deletes it first; this is the backup for one that never does, such as a failed first clone.
     */
    expireAt(deleteAt: number): Promise<void> {
        return this.ctx.storage.setAlarm(deleteAt);
    }

    /** Delete the workspace: the container, files, git data, and the backup alarm. The object then restarts empty. */
    destroy(): Promise<void> {
        const { ctx } = this;

        return answer(
            Effect.gen(function* () {
                if (ctx.container?.running === true) {
                    const container = ctx.container;

                    yield* workspaceCall(() => container.destroy('workspace deleted'));
                }

                yield* workspaceCall(() => ctx.storage.deleteAlarm());
                yield* workspaceCall(() => ctx.storage.deleteAll());
                /**
                 * The in-memory workspace must go: its tables are gone. Wait until this call has answered:
                 * Cloudflare holds the answer until the delete is saved, and an abort before then fails the call.
                 * abort throws to unwind; the object resets either way.
                 */
                yield* Effect.forkDetach(
                    Effect.sleep(RESTART_DELAY).pipe(
                        Effect.andThen(Effect.try(() => ctx.abort('workspace deleted'))),
                        Effect.ignore,
                    ),
                );
            }),
        );
    }

    /** Only `expireAt` sets the alarm, and each call replaces it, so it fires at the latest deadline. */
    override alarm(): Promise<void> {
        return this.destroy();
    }

    /**
     * Run one command. A command that fails still succeeds here, with its exit code. Output past
     * {@link COMMAND_OUTPUT_LIMITS} comes back as its end, with the whole stream saved under
     * {@link TOOL_OUTPUT_DIRECTORY}.
     */
    exec(input: CommandInput): Promise<CommandOutput> {
        return answer(this.run(input));
    }

    private run(input: CommandInput): Effect.Effect<CommandOutput, WorkspaceThrew, Scope.Scope> {
        return Effect.gen({ self: this }, function* () {
            const workspace = yield* workspaceOf(this);

            const handle = yield* Effect.acquireDisposable(
                workspaceCall(() =>
                    workspace.runtime.exec(input.command, {
                        backend: input.backend,
                        cwd: input.cwd,
                        encoding: 'utf8',
                        timeoutMs: input.timeoutMs,
                    }),
                ),
            );

            const { status, exitCode, stdout, stderr, truncated } = yield* workspaceCall(() => handle.result());

            return {
                status,
                exitCode,
                stdout,
                stderr,
                truncated: { stdout: truncatedStream(truncated?.stdout), stderr: truncatedStream(truncated?.stderr) },
            };
        });
    }
}

export default {
    fetch: () => new Response('Not found', { status: 404 }),
} satisfies ExportedHandler;
