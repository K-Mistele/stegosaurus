/**
 * Builds the fold packages' publishable `dist/`, ported from humanlayer/fold's `scripts/build/packages.ts`.
 * Each package's `publishConfig` points `exports`/`types`/`bin` at `dist/`; `pnpm pack` (and so `pkg pack`)
 * applies it, so the workspace keeps importing `src/` while published tarballs carry built JavaScript.
 *
 * - The vendored effect-ai providers: tsc emits JavaScript and declarations.
 * - Every other package: Bun bundles each entry point (dependencies stay external), tsc emits declarations.
 * - fold-cli: bundled with its dependencies through the OpenTUI Solid plugin, with `FOLD_VERSION` defined.
 *   `@opentui/core` and `@silvia-odwyer/photon-node` stay external: they load native or wasm files from their
 *   install path, which bundling would freeze to the build machine's.
 *
 * Usage: `bun packages/fold-cli/scripts/build-packages.ts [--version x.y.z]` (root script: `pnpm build:packages`).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin';

const root = join(import.meta.dirname, '../../..');

// Dependency order: each package builds after the ones it imports.
const libraries = [
    'effect-branded-id',
    'effect-ai-openai',
    'effect-ai-anthropic',
    'effect-ai-openai-compat',
    'fold-core',
    'fold-codex',
    'fold-opencode',
    'fold-xai',
    'fold-agent',
    'fold-tui-theme',
    'fold-cli',
] as const;

type ExportValue = string | null | { readonly source?: string; readonly import?: string };

type Manifest = {
    readonly name: string;
    readonly exports: Record<string, ExportValue>;
    readonly bin?: Record<string, string>;
};

const version = process.argv.find((_, index, args) => args[index - 1] === '--version') ?? '0.0.0';
const tsc = join(root, 'node_modules/.bin/tsc');

for (const name of libraries) {
    const dir = join(root, 'packages', name);
    const manifest: Manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const entries = new Set<string>();

    for (const value of Object.values(manifest.exports)) {
        const entry = typeof value === 'string' ? value : (value?.source ?? value?.import);

        if (entry === undefined || !/\.[cm]?[jt]sx?$/.test(entry)) continue;

        if (!entry.includes('*')) {
            entries.add(entry);
            continue;
        }

        for await (const file of new Bun.Glob(entry.replace(/^\.\//, '')).scan({ cwd: dir, onlyFiles: true })) {
            entries.add(`./${file}`);
        }
    }

    for (const entry of Object.values(manifest.bin ?? {})) {
        entries.add(entry.replace(/^(?:\.\/)?dist\//, './src/').replace(/\.js$/, '.ts'));
    }

    if (entries.size === 0) throw new Error(`No TypeScript entry points found for ${manifest.name}`);

    const outdir = join(dir, 'dist');
    await rm(outdir, { recursive: true, force: true });
    await mkdir(outdir, { recursive: true });

    const effectAiProvider = name.startsWith('effect-ai-');

    if (!effectAiProvider) {
        const cli = name === 'fold-cli';
        const result = await Bun.build({
            entrypoints: [...entries].map((entry) => join(dir, entry)),
            outdir,
            root: join(dir, 'src'),
            target: 'node',
            format: 'esm',
            packages: cli ? 'bundle' : 'external',
            // Packages that load native or wasm files from their own install path stay external.
            external: cli ? ['@opentui/core', '@opentui/core/*', '@silvia-odwyer/photon-node'] : [],
            sourcemap: 'external',
            plugins: cli ? [createSolidTransformPlugin()] : [],
            define: cli ? { FOLD_VERSION: JSON.stringify(version) } : {},
        });

        if (!result.success) throw new AggregateError(result.logs, `Failed to build ${manifest.name}`);
    }

    const compilerOptions: Record<string, boolean | string> = {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: !effectAiProvider,
        outDir: './dist',
        rootDir: './src',
    };

    if (effectAiProvider) {
        // The providers import `./x.ts`; emitting them as-is needs Node resolution and rewritten extensions.
        compilerOptions.module = 'NodeNext';
        compilerOptions.moduleResolution = 'NodeNext';
        compilerOptions.rewriteRelativeImportExtensions = true;
        compilerOptions.sourceMap = true;
    }

    const buildConfig = join(dir, 'tsconfig.release.json');
    await writeFile(
        buildConfig,
        `${JSON.stringify({ extends: './tsconfig.json', compilerOptions, include: ['src'], exclude: ['test', 'examples', 'scripts'] }, null, 2)}\n`,
    );

    const declaration = Bun.spawn([tsc, '-p', buildConfig], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
    const exitCode = await declaration.exited;
    await rm(buildConfig, { force: true });

    if (exitCode !== 0) throw new Error(`Failed to emit declarations for ${manifest.name}`);

    console.log(`built ${manifest.name}`);
}
