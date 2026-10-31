/**
 * The agent's `bash` tool, running commands on the session's workspace in one of two places: the shell
 * (just-bash, fast, with the common text commands and git) or the container (Linux, with package managers
 * and language runtimes, slower to start). fold-agent's bash tool starts real processes, which a Worker
 * cannot; this one keeps its parameters and its output handling - stdout and stderr cut to their last
 * 2000 lines or 50KB with the whole output saved to a file in the workspace, and a failure carrying the
 * output when the command fails - and adds `backend`. The Computer does the cutting and saving, as the
 * command runs, so the full output never crosses to this Worker.
 */
import { defineTool, formatSize, ToolResultFailure, ToolResultText, type FoldTool } from '@stegosaurus/fold-core';
import { Array as Arr, Effect, Predicate, Schema, String as Str } from 'effect';

import { COMMAND_OUTPUT_LIMITS, type CommandOutput, type TruncatedStream, WORKSPACE_ROOT } from './computer/Contract';
import { Workspace } from './Workspace';

const DEFAULT_TIMEOUT_MS = 120_000;

const MAX_TIMEOUT_MS = 600_000;

const BashParameters = Schema.Struct({
    command: Schema.String.annotate({ description: 'Bash command to execute' }),
    backend: Schema.optionalKey(Schema.Literals(['shell', 'container'])).annotate({
        description:
            'Where to run the command: "shell" (default; fast, text commands and git only) or "container" ' +
            '(full Linux: installs, builds, tests)',
    }),
    timeout_ms: Schema.optionalKey(Schema.Finite).annotate({
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS})`,
    }),
    workdir: Schema.optionalKey(Schema.String).annotate({
        description: `Working directory for the command, absolute or relative to ${WORKSPACE_ROOT}. Use this instead of cd.`,
    }),
    description: Schema.optionalKey(Schema.String).annotate({
        description: 'Short (5-10 word) description of what this command does',
    }),
});

const DESCRIPTION =
    `Run a bash command in the session's workspace, where the repo(s) are cloned under ${WORKSPACE_ROOT}. ` +
    'Returns stdout then stderr, keeping the last ' +
    `${COMMAND_OUTPUT_LIMITS.maxLines} lines or ${formatSize(COMMAND_OUTPUT_LIMITS.maxBytes)}, with the full output saved to a file you can read. Commands start in ${WORKSPACE_ROOT} unless ` +
    'you pass workdir.\n\n' +
    'Commands run in one of two places, which see the same files:\n' +
    '- backend "shell" (the default): a lightweight shell (just-bash), not a full Linux machine. It has the ' +
    'common text commands - ls, cat, head, tail, grep, find, sed, awk, sort, uniq, wc, diff, cut, tr, xargs, ' +
    'jq and more - pipes, redirects, and git (clone, status, diff, log, add, commit, branch, checkout). It has ' +
    'no package managers, no node or python, no compilers, and no network access. It answers at once. Use it ' +
    'to explore and search the repos: list directories, grep for code, and inspect git history.\n' +
    '- backend "container": a Debian Linux container where commands run as root in a bash login shell, with ' +
    'internet access, git, node 24 with npm and pnpm, bun, ' +
    'python3, ripgrep, fd and tmux; install anything else with apt-get or a package manager. Use it to install ' +
    'dependencies, build, and run tests or scripts. It can take up to 30 seconds to start if it was stopped. ' +
    'Programs and files outside the workspace last only until it stops; files under the workspace are kept, ' +
    "except those a repo's .gitignore lists (node_modules, build output, caches): they stay in the container " +
    'only, so the shell and the file tools cannot see them, and they are gone once the container stops, so ' +
    'reinstall or rebuild after a restart. Look at them with container commands. A gitignored file you made ' +
    'with the file tools, such as .env, does not receive changes made in the container; change it with the ' +
    'file tools.\n\n' +
    'Try the shell first, and switch to the container when a command is not found or needs a real machine.';

/** The command's output: stdout, then stderr. */
const combinedOutput = ({ stdout, stderr }: CommandOutput) =>
    stdout.length > 0 && stderr.length > 0 ? `${Str.replace(/\n?$/, '\n')(stdout)}${stderr}` : stdout + stderr;

/** Which lines of a cut stream are shown, and where the whole stream is. */
const truncationNotice = (stream: 'stdout' | 'stderr', truncated: TruncatedStream) => {
    const saved =
        truncated.path === null
            ? `The full output could not be saved: ${truncated.notSavedReason ?? 'no reason given'}`
            : `Full output: ${truncated.path}`;

    return `[${stream}: showing lines ${truncated.firstLine}-${truncated.totalLines} of ${truncated.totalLines}. ${saved}]`;
};

/**
 * The output as the model sees it: stdout then stderr, each its end when it was too long, followed by where
 * each cut stream was saved in full.
 */
export const visibleCommandOutput = (output: CommandOutput) => {
    const text = Str.replace(/\n+$/, '')(combinedOutput(output));

    const notices = Arr.filter(
        [
            output.truncated.stdout === null ? null : truncationNotice('stdout', output.truncated.stdout),
            output.truncated.stderr === null ? null : truncationNotice('stderr', output.truncated.stderr),
        ],
        Predicate.isNotNull,
    );

    return Arr.isReadonlyArrayNonEmpty(notices) ? `${text}\n\n${Arr.join(notices, '\n')}` : text;
};

/** The bash tool, over the session's {@link Workspace}. */
export const bashTool: FoldTool<Workspace> = defineTool({
    name: 'bash',
    description: DESCRIPTION,
    parameters: BashParameters,
    success: ToolResultText,
    failure: ToolResultFailure,
    handler: (params) =>
        Effect.gen(function* () {
            const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
                return yield* Effect.fail(`Invalid timeout_ms: must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
            }

            const cwd =
                params.workdir === undefined
                    ? WORKSPACE_ROOT
                    : Str.startsWith('/')(params.workdir)
                      ? params.workdir
                      : `${WORKSPACE_ROOT}/${params.workdir}`;

            const workspace = yield* Workspace;

            const output = yield* workspace
                .exec({
                    backend: params.backend ?? 'shell',
                    command: params.command,
                    cwd,
                    timeoutMs,
                })
                .pipe(Effect.mapError((error) => `The shell could not run the command: ${error.message}`));

            const text = visibleCommandOutput(output);

            if (output.status === 'cancelled') {
                return yield* Effect.fail(`${text}\n\nCommand timed out after ${timeoutMs} milliseconds`);
            }

            if (output.exitCode !== 0) {
                return yield* Effect.fail(`${text}\n\nCommand exited with code ${output.exitCode}`);
            }

            return ToolResultText.make({ text: text.length === 0 ? '(no output)' : text });
        }).pipe(Effect.mapError((text) => ToolResultFailure.make({ text }))),
});
