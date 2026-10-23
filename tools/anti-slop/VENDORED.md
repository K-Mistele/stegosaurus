# Vendored: anti-slop

- Upstream: https://github.com/k-mistele/anti-slop
- Commit: 0548e248f444be9744a0a3d381b53e6983db41e0 (2026-10-15)
- Copied: `src/` (rules and RuleTester tests) and `LICENSE`.

This copy is ours to change. Upstream wants rules edited in place to fit the repo, so don't treat it as read-only.

Tests run with `vp test` (Vitest globals); upstream runs each test file with `tsx`.

## Additions

`src/effect/rules/prefer-tagged-error-handling.ts` and its test match anti-slop `main`. The rule started in the monorepo template (https://github.com/humanlayer/typescript-monorepo-template, originally from Fold; see `PROVENANCE.md`) as a text-matching check; anti-slop rewrote it on the AST.
