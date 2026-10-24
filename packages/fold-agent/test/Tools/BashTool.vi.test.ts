/**
 * Bash tool tests: real processes in temp dirs. Covers output capture and exit-code semantics, the
 * timeout kill (including grandchildren via the process group), schema-typed stdout/stderr streaming
 * deltas, tail truncation with spill files, EPIPE-style pipelines, and input validation.
 */
import { homedir } from 'node:os';

import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it } from '@effect/vitest';
import { Array as Arr, Clock, Duration, Effect, Fiber, FileSystem, Option, Path, String as Str } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { bashTool, codingTools, decodeBashOutputDelta } from '../../src/index';
import { handlerOf, makeAmbientServices, messageOf, outputOf, runHandler, tempDir } from '../TestHelpers';

it.live('captures stdout and reports success on exit 0', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;
        const result = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'echo hello fold' }));

        expect(yield* outputOf(result)).toBe('hello fold\n');
    }),
);

it.live('omits null-containing stdout with a model-actionable notice', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;
        const ambient = yield* makeAmbientServices;

        const result = yield* handlerOf(bashTool({ cwd: dir }))({ command: `printf 'before\\0after'` }).pipe(
            Effect.provide(ambient.layer),
        );

        expect(yield* outputOf(result)).toContain(
            '[stdout output omitted because it contained binary data or invalid UTF-8]',
        );
        expect(yield* outputOf(result)).not.toContain('\0');
        expect(
            Arr.every(
                Arr.map(yield* ambient.emitted, decodeBashOutputDelta),
                (delta) => delta === null || !Str.includes('\0')(delta.text),
            ),
        ).toBe(true);
    }),
);

it.live('omits malformed UTF-8 stderr with a model-actionable notice', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;
        const result = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: `printf '\\200' >&2` }));

        expect(yield* outputOf(result)).toContain(
            '[stderr output omitted because it contained binary data or invalid UTF-8]',
        );
        expect(yield* outputOf(result)).not.toContain('\uFFFD');
    }),
);

it.live('passes host-provided session environment to Bash subprocesses', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const result = yield* runHandler(
            handlerOf(
                bashTool({
                    cwd: dir,
                    processEnvironment: {
                        HUMANLAYER_SESSION_ID: 'session-from-host',
                        HUMANLAYER_SESSION_EXPIRES: '4102444800000',
                    },
                }),
            )({ command: 'printf "%s:%s" "$HUMANLAYER_SESSION_ID" "$HUMANLAYER_SESSION_EXPIRES"' }),
        );

        expect(yield* outputOf(result)).toBe('session-from-host:4102444800000');
    }),
);

it.live('forwards host-provided session environment through codingTools', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const bash = Option.getOrUndefined(
            Arr.findFirst(
                codingTools({
                    cwd: dir,
                    processEnvironment: { HUMANLAYER_SESSION_ID: 'coding-tools-session' },
                }),
                (tool) => tool.name === 'bash',
            ),
        );

        if (bash === undefined) throw new Error('expected codingTools to include Bash');

        const result = yield* runHandler(handlerOf(bash)({ command: 'printf "%s" "$HUMANLAYER_SESSION_ID"' })).pipe(
            Effect.provide(FetchHttpClient.layer),
        );

        expect(yield* outputOf(result)).toBe('coding-tools-session');
    }),
);

it.live('interleaves stderr into the same output buffer', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const result = yield* runHandler(
            handlerOf(bashTool({ cwd: dir }))({ command: 'echo out && echo err 1>&2 && echo out2' }),
        );

        expect(yield* outputOf(result)).toContain('out');
        expect(yield* outputOf(result)).toContain('err');
        expect(yield* outputOf(result)).toContain('out2');
    }),
);

it.live('runs in the provided workdir', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'marker.txt'), 'present');

        const result = yield* runHandler(handlerOf(bashTool(undefined))({ command: 'ls', workdir: dir }));

        expect(yield* outputOf(result)).toContain('marker.txt');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('expands a home-relative configured working directory', () =>
    Effect.gen(function* () {
        const result = yield* runHandler(handlerOf(bashTool({ cwd: '~' }))({ command: 'pwd' }));

        expect(Str.trim(yield* outputOf(result))).toBe(homedir());
    }),
);

it.live('expands a home-relative command working directory', () =>
    Effect.gen(function* () {
        const result = yield* runHandler(handlerOf(bashTool(undefined))({ command: 'pwd', workdir: '~' }));

        expect(Str.trim(yield* outputOf(result))).toBe(homedir());
    }),
);

it.live('non-zero exits are typed failures carrying output and the exit code', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const failure = yield* runHandler(
            handlerOf(bashTool({ cwd: dir }))({ command: 'echo some output && exit 3' }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe('some output\n\n\nCommand exited with code 3');
    }),
);

it.live('missing workdir fails fast with the pi message', () =>
    Effect.gen(function* () {
        const failure = yield* runHandler(
            handlerOf(bashTool(undefined))({ command: 'echo hi', workdir: '/definitely/not/here' }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe(
            'Working directory does not exist: /definitely/not/here\nCannot execute bash commands.',
        );
    }),
);

it.live('invalid timeouts are rejected before spawning', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const failure = yield* runHandler(
            handlerOf(bashTool({ cwd: dir }))({ command: 'echo hi', timeout_ms: -1 }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe('Invalid timeout_ms: must be a finite number of milliseconds');
    }),
);

it.live('timeout kills the whole process group, including grandchildren', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const grandchildMarker = path.join(dir, 'grandchild-survived.txt');

        // The command spawns a backgrounded grandchild that would write a marker after 2s. The 1000ms
        // timeout must kill the entire group, so the marker never appears.
        const failure = yield* runHandler(
            handlerOf(bashTool({ cwd: dir }))({
                command: `(sleep 2 && echo alive > ${grandchildMarker}) & echo started && sleep 10`,
                timeout_ms: 1_000,
            }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toContain('started');
        expect(yield* messageOf(failure)).toContain(
            '<system-reminder>Command timed out after 1000 milliseconds</system-reminder>',
        );

        // Give any surviving grandchild time to prove itself, then assert it was killed.
        yield* Effect.sleep(Duration.millis(2500));
        expect(yield* fs.exists(grandchildMarker)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('emits schema-typed stdout/stderr deltas while running', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;
        const ambient = yield* makeAmbientServices;

        yield* handlerOf(bashTool({ cwd: dir }))({ command: 'echo to-stdout && echo to-stderr 1>&2' }).pipe(
            Effect.provide(ambient.layer),
        );

        const deltas = Arr.map(yield* ambient.emitted, decodeBashOutputDelta);
        expect(Arr.every(deltas, (delta) => delta !== null)).toBe(true);

        const stdoutText = Arr.join(
            Arr.map(
                Arr.filter(deltas, (delta) => delta?.stream === 'stdout'),
                (delta) => delta?.text ?? '',
            ),
            '',
        );

        const stderrText = Arr.join(
            Arr.map(
                Arr.filter(deltas, (delta) => delta?.stream === 'stderr'),
                (delta) => delta?.text ?? '',
            ),
            '',
        );

        expect(stdoutText).toBe('to-stdout\n');
        expect(stderrText).toBe('to-stderr\n');
    }),
);

it.live('tail-truncates long output and spills the full output to a file', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        // Keep the ambient output store open while the spill file is read back.
        const ambient = yield* makeAmbientServices;

        const result = yield* handlerOf(bashTool({ cwd: dir }))({ command: 'seq 1 3000' }).pipe(
            Effect.provide(ambient.layer),
        );

        const output = yield* outputOf(result);

        // Tail direction: the last lines survive, the head is cut. pi's line accounting: the trailing
        // newline terminates line 3000 rather than opening line 3001.
        expect(output).toContain('\n3000\n');
        expect(Str.startsWith('1001\n')(output)).toBe(true);
        expect(output).toContain('[Showing lines 1001-3000 of 3000. Full output: ');

        const spillPath = Option.getOrUndefined(
            Option.flatMap(Str.match(/Full output: (\S+)\]/)(output), (match) => Option.fromUndefinedOr(match[1])),
        );

        if (spillPath === undefined) throw new Error('expected a spill path in the notice');
        expect(yield* fs.exists(spillPath)).toBe(true);
        const spilled = yield* fs.readFileString(spillPath);
        expect(Str.startsWith('1\n2\n3\n')(spilled)).toBe(true);
        expect(Str.endsWith('2999\n3000\n')(spilled)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('spills to the output store at a deterministic per-tool-call path', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const ambient = yield* makeAmbientServices;

        const result = yield* handlerOf(bashTool({ cwd: dir }))({ command: 'seq 1 3000' }).pipe(
            Effect.provide(ambient.layer),
        );

        // The ambient CurrentToolCall id names the file inside the provided store's directory.
        const expectedPath = path.join(ambient.outputDirectory, 'tool_call_aaaaaaaaaaaaaaaaaaaaaaaa.txt');

        expect(yield* outputOf(result)).toContain(`Full output: ${expectedPath}`);
        expect(yield* fs.readFileString(expectedPath)).toContain('1\n2\n3\n');
        expect(yield* fs.readFileString(expectedPath)).toContain('2999\n3000\n');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('byte-limit truncation reports the size-limited notice with the spill path', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        // ~100KB of output in few lines: byte limit binds before the line limit.
        const result = yield* runHandler(
            handlerOf(bashTool({ cwd: dir }))({
                command: `for i in $(seq 1 100); do printf 'x%.0s' $(seq 1 1024); printf '\\n'; done`,
            }),
        );

        const output = yield* outputOf(result);

        expect(output).toContain('(50.0KB limit). Full output: ');
    }),
);

it.live('EPIPE-style pipelines complete normally', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;
        // `head -1` closes the pipe early; `seq` receives EPIPE/SIGPIPE. The pipeline still exits 0.
        const result = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'seq 1 100000 | head -1' }));

        expect(yield* outputOf(result)).toBe('1\n');
    }),
);

it.live('reports (no output) for silent commands', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;
        const result = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'true' }));

        expect(yield* outputOf(result)).toBe('(no output)');
    }),
);

it.live('escalates to SIGKILL for commands that trap SIGTERM', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;
        const started = yield* Clock.currentTimeMillis;

        // The command ignores SIGTERM; only the 200ms SIGKILL escalation can end it.
        const failure = yield* runHandler(
            handlerOf(bashTool({ cwd: dir }))({ command: "trap '' TERM; echo trapped; sleep 30", timeout_ms: 1_000 }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toContain('trapped');
        expect(yield* messageOf(failure)).toContain(
            '<system-reminder>Command timed out after 1000 milliseconds</system-reminder>',
        );
        // 1s timeout + 200ms grace + slack: far below the 30s sleep.
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(10_000);
    }),
);

it.live('a signal-killed command is a success, not an error (pi semantics)', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const result = yield* runHandler(
            handlerOf(bashTool({ cwd: dir }))({ command: 'echo before && kill -KILL $$' }),
        );

        expect(yield* outputOf(result)).toBe('before\n');
    }),
);

it.live('an empty-output timeout reports only the status (no "(no output)" prefix)', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const failure = yield* runHandler(
            handlerOf(bashTool({ cwd: dir }))({ command: 'sleep 5', timeout_ms: 1_000 }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe(
            '<system-reminder>Command timed out after 1000 milliseconds</system-reminder>',
        );
    }),
);

it.live('streams output to the spill file as it is written; interruption notes the path (ruling 5)', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const ambient = yield* makeAmbientServices;
        const tool = bashTool({ cwd: dir });

        const commandFiber = yield* Effect.forkChild(
            handlerOf(tool)({ command: 'echo early-output; sleep 30' }).pipe(
                Effect.provide(ambient.layer),
                Effect.exit,
            ),
        );

        // The streamed chunk lands on disk long before the command could finish (stream-as-written).
        let spill = { path: '', content: '' };

        while (!Str.includes('early-output')(spill.content)) {
            const file = Arr.findFirst(yield* fs.readDirectory(ambient.outputDirectory), Str.endsWith('.txt'));

            if (Option.isSome(file)) {
                const spillPath = path.join(ambient.outputDirectory, file.value);
                spill = { path: spillPath, content: yield* fs.readFileString(spillPath) };
            }

            if (!Str.includes('early-output')(spill.content)) yield* Effect.sleep(Duration.millis(25));
        }

        yield* Fiber.interrupt(commandFiber);

        expect(spill.content).toContain('early-output');
        const note = yield* ambient.interruptNote;
        expect(note).toContain(spill.path);
        expect(note).toContain('partial output');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
