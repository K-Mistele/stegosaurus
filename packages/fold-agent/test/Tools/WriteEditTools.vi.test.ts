import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it } from '@effect/vitest';
import { ToolResultText } from '@stegosaurus/fold-core';
import { Effect, FileSystem, Path } from 'effect';

import { editTool, writeTool } from '../../src/index';
import { handlerOf, messageOf, runHandler, tempDir } from '../TestHelpers';

it.effect('write creates parent directories and the file', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;

        const result = yield* runHandler(
            handlerOf(writeTool({ cwd: dir }))({ path: 'nested/deeper/new.txt', content: 'hello fold\n' }),
        );

        expect(result).toEqual(ToolResultText.make({ text: 'Successfully wrote 11 bytes to nested/deeper/new.txt' }));
        expect(yield* fs.readFileString(path.join(dir, 'nested/deeper/new.txt'))).toBe('hello fold\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('write overwrites existing files and reports true UTF-8 bytes (not UTF-16 length)', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'file.txt'), 'old');

        // One emoji: 2 UTF-16 code units (pi would say 2), 4 UTF-8 bytes (fold reports 4 - D18).
        const result = yield* runHandler(handlerOf(writeTool({ cwd: dir }))({ path: 'file.txt', content: '🎉' }));

        expect(result).toEqual(ToolResultText.make({ text: 'Successfully wrote 4 bytes to file.txt' }));
        expect(yield* fs.readFileString(path.join(dir, 'file.txt'))).toBe('🎉');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('edit applies a batch and reports the pi success message', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'code.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n');

        const result = yield* runHandler(
            handlerOf(editTool({ cwd: dir }))({
                path: 'code.ts',
                edits: [
                    { oldText: 'const a = 1', newText: 'const a = 10' },
                    { oldText: 'const c = 3', newText: 'const c = 30' },
                ],
            }),
        );

        expect(result).toEqual(ToolResultText.make({ text: 'Successfully replaced 2 block(s) in code.ts.' }));
        expect(yield* fs.readFileString(path.join(dir, 'code.ts'))).toBe('const a = 10\nconst b = 2\nconst c = 30\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('edit accepts the legacy single-pair form through the shim', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'legacy.txt'), 'alpha beta\n');

        const result = yield* runHandler(
            handlerOf(editTool({ cwd: dir }))({ path: 'legacy.txt', oldText: 'beta', newText: 'gamma' }),
        );

        expect(result).toEqual(ToolResultText.make({ text: 'Successfully replaced 1 block(s) in legacy.txt.' }));
        expect(yield* fs.readFileString(path.join(dir, 'legacy.txt'))).toBe('alpha gamma\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('edit surfaces engine failures as model-visible messages and leaves the file untouched', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'f.txt'), 'content\n');

        const failure = yield* runHandler(
            handlerOf(editTool({ cwd: dir }))({ path: 'f.txt', edits: [{ oldText: 'missing', newText: 'x' }] }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe(
            'Could not find the exact text in f.txt. The old text must match exactly including all whitespace and newlines.',
        );
        expect(yield* fs.readFileString(path.join(dir, 'f.txt'))).toBe('content\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('edit preserves CRLF endings on disk', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'crlf.txt'), 'one\r\ntwo\r\n');

        yield* runHandler(
            handlerOf(editTool({ cwd: dir }))({ path: 'crlf.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }),
        );

        expect(yield* fs.readFileString(path.join(dir, 'crlf.txt'))).toBe('one\r\nTWO\r\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('edit fails for missing files with pi access-gate message, without creating them', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;

        const failure = yield* runHandler(
            handlerOf(editTool({ cwd: dir }))({ path: 'ghost.txt', edits: [{ oldText: 'a', newText: 'b' }] }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe('Could not edit file: ghost.txt. Error code: ENOENT.');
        expect(yield* fs.exists(path.join(dir, 'ghost.txt'))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('parallel same-file mutations serialize through the mutation queue (both land)', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'shared.txt'), 'line-a\nline-b\n');
        const edit = editTool({ cwd: dir });

        // Both edits target the original content; serialization means the second sees the first's
        // write and still matches (its target line is untouched by the first edit).
        yield* Effect.all(
            [
                runHandler(handlerOf(edit)({ path: 'shared.txt', edits: [{ oldText: 'line-a', newText: 'LINE-A' }] })),
                runHandler(handlerOf(edit)({ path: 'shared.txt', edits: [{ oldText: 'line-b', newText: 'LINE-B' }] })),
            ],
            { concurrency: 2 },
        );

        expect(yield* fs.readFileString(path.join(dir, 'shared.txt'))).toBe('LINE-A\nLINE-B\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);
