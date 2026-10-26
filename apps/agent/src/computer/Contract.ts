/**
 * What both sides of the Computer boundary share: where repos live, and the values its RPC methods take and
 * return. Plain values only. The Computer Worker's name is `computerName(stage)` in `../Names`.
 *
 * Computer methods throw on failure. Workers RPC keeps a thrown error's `name`, `message`, `code` and other
 * own fields (`enhanced_error_serialization`, on from compatibility date 2026-04-21), so the caller reads
 * `code` (`ENOENT`, `EISDIR`, ...) off the rejection.
 */

/** Every repo clones into `${WORKSPACE_ROOT}/<name>`. */
export const WORKSPACE_ROOT = '/workspace';

/** The Computer's binding name on its own Worker, which the shell uses to call back into it. */
export const COMPUTER_BINDING = 'Computer';

/**
 * The container image's key in `ctx.container.images`: the id of the `Cloudflare.Container` the Computer
 * Durable Object lists (see `ComputerWorker.ts`).
 */
export const COMPUTER_CONTAINER_IMAGE = 'ComputerContainer';

/**
 * Request headers for one git network operation, such as a private repository's `Authorization`. Sent with
 * that request only: never written to the remote's URL, `.git/config`, or a log.
 */
export type GitHeaders = Readonly<Record<string, string>>;

/**
 * Who the agent's commits are by: the Stegosaurus.tech App's bot user, by its noreply address, so GitHub
 * links the commits to it. Written to each repo's own git config.
 */
export const GIT_IDENTITY = {
    name: 'stegosaurus-tech[bot]',
    email: '347123140+stegosaurus-tech[bot]@users.noreply.github.com',
} as const;

/** Where the Computer saves command output too long to return in full, outside every repository. */
export const TOOL_OUTPUT_DIRECTORY = `${WORKSPACE_ROOT}/.fold/tool-output`;

/**
 * How much of each output stream a command result keeps: its last 2000 lines or 50 KiB, whichever is less.
 * The same limits as fold's `truncateTail`, so the bash tool reads like fold's own.
 */
export const COMMAND_OUTPUT_LIMITS = { maxLines: 2000, maxBytes: 50 * 1024 } as const;

export type PrepareRepoInput = {
    /** The directory under `/workspace`. */
    readonly name: string;
    /** An https URL with no credentials. */
    readonly url: string;
    /**
     * The branch to work on: checked out from the remote when it is there, otherwise created from the
     * default branch and pushed. `null` stays on the default branch.
     */
    readonly branch: string | null;
    readonly headers: GitHeaders;
};

export type PreparedRepo = {
    readonly dir: string;
    /** The branch checked out. */
    readonly branch: string;
    /** The remote's default branch. */
    readonly defaultBranch: string;
    /** The commit checked out. */
    readonly commit: string;
    /** Whether `branch` was new, so this created it and pushed it. */
    readonly createdBranch: boolean;
};

/** A pulled repo's commit before and after the pull; the same commit when nothing came in. */
export type PulledRepo = {
    readonly before: string;
    readonly after: string;
};

/** A remote branch fetched into `origin/<branch>`. */
export type FetchedBranch = {
    readonly branch: string;
    readonly commit: string;
};

/** A branch pushed to the remote branch of the same name. */
export type PushedBranch = {
    readonly branch: string;
    readonly commit: string;
};

/** A ref merged into the current branch. */
export type MergedRef = {
    readonly commit: string;
    readonly fastForward: boolean;
    readonly alreadyMerged: boolean;
};

export type FileInfo = {
    readonly type: 'File' | 'Directory' | 'SymbolicLink';
    readonly size: number;
    /** Milliseconds since the epoch. */
    readonly mtime: number;
    readonly mode: number;
    readonly inode: number;
};

/**
 * Where a command runs: `shell` is just-bash in a Worker, fast but with only text commands and git;
 * `container` is a Linux container with node, bun, python and internet access, slow to start.
 */
export type Backend = 'shell' | 'container';

/** One command, run on `backend` in `cwd` and stopped after `timeoutMs`. */
export type CommandInput = {
    readonly backend: Backend;
    readonly command: string;
    readonly cwd: string;
    readonly timeoutMs: number;
};

/**
 * One output stream cut to its end because it passed {@link COMMAND_OUTPUT_LIMITS}: where it was saved in
 * full, or why saving failed, and which lines were kept.
 */
export type TruncatedStream = {
    /** The workspace file holding the whole stream, or `null` when saving it failed. */
    readonly path: string | null;
    /** Why the stream could not be saved; `null` when it was. */
    readonly notSavedReason: string | null;
    readonly totalLines: number;
    /** One-based number of the first line kept. */
    readonly firstLine: number;
};

export type CommandOutput = {
    /** `cancelled` when the command hit its timeout. */
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly exitCode: number;
    /** The whole stream, or its end when {@link truncated} names it. */
    readonly stdout: string;
    readonly stderr: string;
    /** The streams that were cut, each absent when it fit. */
    readonly truncated: { readonly stdout: TruncatedStream | null; readonly stderr: TruncatedStream | null };
};
