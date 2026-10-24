import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Path } from 'effect';

import { applyPatchTool } from '../../src/index';
import { handlerOf, messageOf, runHandler, tempDir } from '../TestHelpers';

it.effect('applies a multi-op V4A patch: add, update with move, delete', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'app.ts'), 'function main() {\n  old()\n}\n');
        yield* fs.writeFileString(path.join(dir, 'legacy.txt'), 'goodbye\n');

        const result = yield* runHandler(
            handlerOf(applyPatchTool({ cwd: dir }))({
                patch_text: Arr.join(
                    [
                        '*** Begin Patch',
                        '*** Add File: docs/notes.md',
                        '+# Notes',
                        '+created by patch',
                        '*** Update File: app.ts',
                        '*** Move to: main.ts',
                        '@@ function main() {',
                        '-  old()',
                        '+  updated()',
                        '*** Delete File: legacy.txt',
                        '*** End Patch',
                    ],
                    '\n',
                ),
            }),
        );

        expect(yield* messageOf(result)).toBe(
            'Applied patch.\nAdded: docs/notes.md\nUpdated: app.ts (moved to main.ts)\nDeleted: legacy.txt',
        );
        expect(yield* fs.readFileString(path.join(dir, 'docs/notes.md'))).toBe('# Notes\ncreated by patch\n');
        expect(yield* fs.readFileString(path.join(dir, 'main.ts'))).toBe('function main() {\n  updated()\n}\n');
        expect(yield* fs.exists(path.join(dir, 'app.ts'))).toBe(false);
        expect(yield* fs.exists(path.join(dir, 'legacy.txt'))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('applies a raw git diff (clanka superset input)', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'x.ts'), 'keep\nremove\n');

        yield* runHandler(
            handlerOf(applyPatchTool({ cwd: dir }))({
                patch_text: Arr.join(
                    [
                        'diff --git a/x.ts b/x.ts',
                        'index 111..222 100644',
                        '--- a/x.ts',
                        '+++ b/x.ts',
                        '@@ -1,2 +1,2 @@',
                        ' keep',
                        '-remove',
                        '+added',
                    ],
                    '\n',
                ),
            }),
        );

        expect(yield* fs.readFileString(path.join(dir, 'x.ts'))).toBe('keep\nadded\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('a failing hunk means zero writes (validate-then-write atomicity)', () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        yield* fs.writeFileString(path.join(dir, 'target.ts'), 'original content\n');

        const failure = yield* runHandler(
            handlerOf(applyPatchTool({ cwd: dir }))({
                patch_text: Arr.join(
                    [
                        '*** Begin Patch',
                        '*** Add File: should-not-exist.txt',
                        '+data',
                        '*** Update File: target.ts',
                        '-line that is not there',
                        '+replacement',
                        '*** End Patch',
                    ],
                    '\n',
                ),
            }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe(
            'apply_patch verification failed: Failed to find expected lines in target.ts:\nline that is not there',
        );
        // Atomicity: the add earlier in the patch never landed.
        expect(yield* fs.exists(path.join(dir, 'should-not-exist.txt'))).toBe(false);
        expect(yield* fs.readFileString(path.join(dir, 'target.ts'))).toBe('original content\n');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('missing update target fails with the verification prefix', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const failure = yield* runHandler(
            handlerOf(applyPatchTool({ cwd: dir }))({
                patch_text: Arr.join(
                    ['*** Begin Patch', '*** Update File: ghost.ts', '-a', '+b', '*** End Patch'],
                    '\n',
                ),
            }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe(
            'apply_patch verification failed: Failed to read file to update: ghost.ts',
        );
    }),
);

it.effect('unparseable patch text fails with the verification prefix', () =>
    Effect.gen(function* () {
        const dir = yield* tempDir;

        const failure = yield* runHandler(
            handlerOf(applyPatchTool({ cwd: dir }))({ patch_text: 'this is not a patch' }),
        ).pipe(Effect.flip);

        expect(yield* messageOf(failure)).toBe(
            'apply_patch verification failed: Invalid patch format: expected *** Begin Patch or a git/unified diff',
        );
    }),
);
