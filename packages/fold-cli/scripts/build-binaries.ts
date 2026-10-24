/**
 * Compiles the `foldcode` native binary for every release target, ported from humanlayer/fold's
 * `scripts/build/binaries.ts`. Output: `dist/fold-<target>/bin/foldcode[.exe]` at the repo root.
 *
 * Usage: `bun packages/fold-cli/scripts/build-binaries.ts [--version x.y.z] [--host] [--skip-install]`
 * (root script: `pnpm build:binaries`). `--host` builds only this machine's target.
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin';
import { Schema } from 'effect';

import { encodeJson, root, targetName, targets } from './release/manifest';

// Bun's compile target for each native package, keyed by the package's directory name.
const compileTargets: Record<string, Bun.Build.CompileTarget> = {
    'fold-linux-arm64': 'bun-linux-arm64',
    'fold-linux-x64': 'bun-linux-x64',
    'fold-linux-x64-baseline': 'bun-linux-x64-baseline',
    'fold-linux-arm64-musl': 'bun-linux-arm64-musl',
    'fold-linux-x64-musl': 'bun-linux-x64-musl',
    'fold-linux-x64-baseline-musl': 'bun-linux-x64-baseline-musl',
    'fold-darwin-arm64': 'bun-darwin-arm64',
    'fold-darwin-x64': 'bun-darwin-x64',
    'fold-darwin-x64-baseline': 'bun-darwin-x64-baseline',
    'fold-windows-arm64': 'bun-windows-arm64',
    'fold-windows-x64': 'bun-windows-x64',
    'fold-windows-x64-baseline': 'bun-windows-x64-baseline',
};

const args = new Set(process.argv.slice(2));
const versionArg = process.argv.find((_, index, all) => all[index - 1] === '--version') ?? '0.0.0';
const selected = args.has('--host')
    ? targets.filter(
          ([os, cpu, variant]) =>
              (os === 'windows' ? 'win32' : os) === process.platform && cpu === process.arch && variant === '',
      )
    : targets;
// OpenTUI loads its native library with `import('@opentui/core-<platform>-<arch>')`, so compiling for another
// target needs that target's package beside @opentui/core. pnpm installs only this machine's, so fetch the rest
// with `npm pack` into the directory @opentui/core resolves its dependencies from.
const opentuiCore = realpathSync(join(root, 'packages/fold-cli/node_modules/@opentui/core'));
if (!args.has('--skip-install')) {
    const { optionalDependencies = {} }: { optionalDependencies?: Record<string, string> } = JSON.parse(
        await readFile(join(opentuiCore, 'package.json'), 'utf8'),
    );
    const scratch = await mkdtemp(join(tmpdir(), 'opentui-native-'));
    try {
        for (const [name, version] of Object.entries(optionalDependencies)) {
            const dest = join(dirname(opentuiCore), name.replace('@opentui/', ''));
            if (existsSync(dest)) continue;
            const packed = Bun.spawn(['npm', 'pack', '--silent', `${name}@${version}`], {
                cwd: scratch,
                stdout: 'pipe',
            });
            const tarball = (await new Response(packed.stdout).text()).trim();
            if ((await packed.exited) !== 0) throw new Error(`Failed to fetch ${name}@${version}`);
            await mkdir(dest, { recursive: true });
            const extract = Bun.spawn(['tar', '-xzf', join(scratch, tarball), '-C', dest, '--strip-components=1']);
            if ((await extract.exited) !== 0) throw new Error(`Failed to unpack ${name}@${version}`);
        }
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

await rm(join(root, 'dist'), { recursive: true, force: true });
const parserWorker = join(opentuiCore, 'parser.worker.js');
const workerRelative = relative(root, parserWorker).replaceAll('\\', '/');

for (const target of selected) {
    const [os, cpu, variant] = target;
    const packageName = targetName(target).replace('@stegosaurus/', '');
    const outdir = join(root, 'dist', packageName, 'bin');
    await mkdir(outdir, { recursive: true });
    const bunTarget = compileTargets[packageName];
    if (bunTarget === undefined) throw new Error(`No Bun compile target for ${packageName}`);
    const bunfs = os === 'windows' ? 'B:/~BUN/root/' : '/$bunfs/root/';
    const define: Record<string, string> = {
        FOLD_VERSION: encodeJson(Schema.String, versionArg),
        OTUI_TREE_SITTER_WORKER_PATH: encodeJson(Schema.String, bunfs + workerRelative),
    };
    if (os === 'linux')
        define['process.env.OPENTUI_LIBC'] = encodeJson(Schema.String, variant.includes('musl') ? 'musl' : 'glibc');
    const result = await Bun.build({
        entrypoints: [join(root, 'packages/fold-cli/src/cli.ts'), parserWorker],
        plugins: [createSolidTransformPlugin()],
        target: 'bun',
        format: 'esm',
        minify: true,
        sourcemap: 'inline',
        define,
        compile: {
            target: bunTarget,
            outfile: join(outdir, os === 'windows' ? 'foldcode.exe' : 'foldcode'),
            autoloadBunfig: false,
            autoloadDotenv: false,
            execArgv: ['--use-system-ca', '--'],
            windows: {},
        },
    });
    if (!result.success) throw new AggregateError(result.logs, `Failed to build ${packageName}`);
    if ((os === 'windows' ? 'win32' : os) === process.platform && cpu === process.arch && variant === '') {
        const binary = join(outdir, os === 'windows' ? 'foldcode.exe' : 'foldcode');
        const smoke = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'inherit' });
        const output = await new Response(smoke.stdout).text();
        if ((await smoke.exited) !== 0 || !output.includes(versionArg))
            throw new Error(`Binary smoke test failed: ${output.trim()}`);
        console.log(`smoke tested ${packageName}: ${output.trim()}`);
    }
}
