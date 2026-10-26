# Vendored: anti-slop

- Upstream: https://github.com/k-mistele/anti-slop
- Commit: d8d5278 (2026-10-23)
- Copied: `src/` (rules, tests, and `src/vendor/eslint-stylistic`) and `LICENSE`.

This copy is ours to change. Upstream wants rules edited in place to fit the repo, so don't treat it as read-only.

Tests run with `vp test` (Vitest globals); upstream runs each test file with `tsx`. `require-readable-spacing-cli.test.ts` is a plain script, not a Vitest suite, so the `test` script runs it with Bun after `vp test`. It calls `pnpm`, so run it through `vp run`.

## Additions

`src/effect/rules/prefer-tagged-error-handling.ts` and its test match anti-slop `main`. The rule started in the monorepo template (https://github.com/humanlayer/typescript-monorepo-template, originally from Fold; see `PROVENANCE.md`) as a text-matching check; anti-slop rewrote it on the AST.

## Local changes

- `tsconfig.json` sets `allowImportingTsExtensions`: the root tsconfig doesn't, and upstream source imports `./x.ts`.
- `package.json` has a `typecheck` script so `pnpm typecheck` covers this package; it runs `tsrs`, like every package.
- `no-manual-tagged-construction` skips `_tag: Schema.tag…(...)` fields (`Schema.tag`, `Schema.tagDefaultOmit`): they declare a schema's tag field, not a hand-built value.
- `no-disabled-type-assertion-rules` is ours: it reports inline `oxlint-disable`/`eslint-disable` comments that turn off a type-assertion rule, and disable comments that name no rule. Put a real exception in a file override instead.
