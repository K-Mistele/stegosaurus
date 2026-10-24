# Vendored: alchemy-test

- Upstream: https://github.com/alchemy-run/alchemy/tree/main/packages/alchemy-test
- Commit: 262407bd3aeb7c054fa679e30355f00912fff690 (2026-10-23)
- Copied: `src/`, `bin/`, `test/`, plus the repo's `LICENSE` (Apache-2.0) and `NOTICE`.

Upstream never publishes this package (it is `private`), yet the published `alchemy` package imports it from `alchemy/Test/Alchemy`. The root `package.json` depends on it twice: as `@stegosaurus/alchemy-test` (`workspace:*`), and under the alias `alchemy-test` (`workspace:@stegosaurus/alchemy-test@*`). The alias puts it at `node_modules/alchemy-test`, where alchemy's files find it.

Local changes:
- `package.json`: exports point at `src/` (no build step); dropped the build scripts, which call alchemy's repo scripts.
- `package.json`: renamed `alchemy-test` to `@stegosaurus/alchemy-test`. The `bin` key stays `alchemy-test`, and the tests still import `alchemy-test`, which resolves through the root alias.
- `package.json`: added a `typecheck` script so `pnpm typecheck` covers this package.
- `tsconfig.json`: inlines the settings of alchemy's `tsconfig.base.json` that matter here.
- Relative imports drop the `.ts` extension (`./Api`, not `./Api.ts`), and `tsconfig.json` drops `allowImportingTsExtensions`. The root typecheck reaches this package through `alchemy/Test/Alchemy` and no longer allows `.ts` imports. Path strings in tests (`../bin/alchemy-test.ts`) keep the extension.

The runner needs Bun: `bun alchemy-test` from a package directory.

Lint and format skip this package to keep it close to upstream.
- `test/Tags.test.ts`: imports `alchemy/Test/Alchemy` instead of `../../alchemy/src/Test/Alchemy.ts` (alchemy's source tree isn't here).
- `test` script: three files (`DevCli`, `Tags`, `forwardSignals`) use `bun:test`, so they run under `bun test`; the rest run under the alchemy-test runner.
