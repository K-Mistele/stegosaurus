/**
 * Points npm trusted publishing at this repo's release workflow for every package the release publishes:
 * the libraries, the native `@stegosaurus/fold-<target>` packages and the `@stegosaurus/fold` wrapper.
 * Each package must already exist on npm (publish an rc first), and the account needs 2FA.
 *
 * The first call asks for 2FA in the browser; choose "skip 2FA for the next 5 minutes" there so the rest go
 * through. Calls are 2 seconds apart, as npm recommends for bulk setup.
 *
 * Usage: `bun packages/fold-cli/scripts/release/trust.ts [--dry-run]` (root script: `pnpm release:trust`).
 */
import { tmpdir } from 'node:os';

import { libraries, targetName, targets } from './manifest';

const repository = 'K-Mistele/stegosaurus';
const workflow = 'release.yml';
const dryRun = process.argv.includes('--dry-run');

const packages = [...libraries.map((name) => `@stegosaurus/${name}`), ...targets.map(targetName), '@stegosaurus/fold'];

for (const [index, name] of packages.entries()) {
    if (index > 0) await Bun.sleep(2000);
    const command = [
        'npm',
        'trust',
        'github',
        name,
        '--file',
        workflow,
        '--repo',
        repository,
        '--allow-publish',
        '--yes',
        ...(dryRun ? ['--dry-run'] : []),
    ];
    console.log(`${dryRun ? 'dry-run' : 'trusting'} ${name}`);
    // Run outside the repo: its devEngines (pnpm) makes npm refuse to run there.
    const child = Bun.spawn(command, { cwd: tmpdir(), stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    if ((await child.exited) !== 0) throw new Error(`npm trust failed for ${name}`);
}
