import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, it } from '@effect/vitest';
import { SessionId, ToolCallId } from '@stegosaurus/fold-core';
import { Effect, FileSystem, Layer } from 'effect';

import {
    layerOutputStore,
    OutputStore,
    sweepToolOutput,
    toolOutputPathFor,
    toolOutputSessionDirFor,
} from '../../src/OutputStore/OutputStore';
import { tempDir } from '../TestHelpers';

it.effect('stores tool output at a deterministic session/tool-call path', () =>
    Effect.gen(function* () {
        const root = yield* tempDir;
        const sessionId = SessionId.make('sess_aaaaaaaaaaaaaaaaaaaaaaaa');
        const toolCallId = ToolCallId.make('tool_call_bbbbbbbbbbbbbbbbbbbbbbbb');
        const expectedPath = toolOutputPathFor({ sessionId, toolCallId, foldHome: root });

        yield* Effect.gen(function* () {
            const store = yield* OutputStore;
            const first = yield* store.append(toolCallId, 'one\n');
            const second = yield* store.append(toolCallId, 'two\nthree');

            expect(first.path).toBe(expectedPath);
            expect(second.path).toBe(expectedPath);
            expect(yield* store.read(first)).toBe('one\ntwo\nthree');
            expect(yield* store.read(first, { offset: 2, limit: 1 })).toBe('two');
        }).pipe(
            Effect.provide(layerOutputStore({ directory: toolOutputSessionDirFor({ sessionId, foldHome: root }) })),
        );
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);

it.live('sweeps old stored output files best-effort', () =>
    Effect.gen(function* () {
        const root = yield* tempDir;
        const sessionId = SessionId.make('sess_cccccccccccccccccccccccc');
        const toolCallId = ToolCallId.make('tool_call_dddddddddddddddddddddddd');

        const ref = yield* Effect.gen(function* () {
            const store = yield* OutputStore;

            return yield* store.append(toolCallId, 'old output');
        }).pipe(
            Effect.provide(layerOutputStore({ directory: toolOutputSessionDirFor({ sessionId, foldHome: root }) })),
        );

        const fs = yield* FileSystem.FileSystem;
        yield* fs.utimes(ref.path, 0, 0);
        expect(yield* fs.exists(ref.path)).toBe(true);

        yield* sweepToolOutput({ foldHome: root, retentionMs: 1 });
        expect(yield* fs.exists(ref.path)).toBe(false);
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);
