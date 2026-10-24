import { homedir } from 'node:os';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, it } from '@effect/vitest';
import { Effect, Path } from 'effect';

import { resolveToCwd } from '../../src/Fs/PathResolve';

it.effect('expands a home-relative configured working directory to an absolute path', () =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(yield* resolveToCwd('~/.humanlayer/workspaces/example', process.cwd())).toBe(
            path.join(homedir(), '.humanlayer', 'workspaces', 'example'),
        );
    }).pipe(Effect.provide(NodePath.layer)),
);
