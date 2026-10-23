# AGENTS.md

pnpm monorepo on Vite+ (`vite-plus`, CLI `vp`). TypeScript, Effect v4, alchemy v2 beta on Cloudflare.

## Commands

Run `pnpm check` before you finish any change.

```sh
pnpm check         # format (writes), lint, typecheck, typed:check; stops at first failure
pnpm ready         # check, then test
pnpm format        # oxfmt, writes files
pnpm format:check  # oxfmt, no writes (CI)
pnpm lint          # oxlint with type-aware rules; does not type check
pnpm lint:fix
pnpm typecheck     # tsc over root tsconfig and each apps/* tsconfig
pnpm typed:check   # typed-lint: TypeScript-API rules from typed-lint.config.json (Bun)
pnpm test          # `vp run -r test`: every package's `test` script
pnpm test:stack    # test/stack.test.ts: runs the alchemy stack in local workerd (Bun)
pnpm dev           # alchemy dev
pnpm deploy        # alchemy deploy
pnpm destroy       # alchemy destroy
```

- Without pnpm: `vp run <script>` (or `./node_modules/.bin/vp run <script>`).
- One package's tests: `vp run <pkg>#test` or `vp run --filter <pkg> test`.
- `vp run` caches results. Pass `--no-cache` to force a run.
- Built-in `vp check` does not type check (lint `typeCheck` is off). Use `pnpm check`.
- Bun must be on PATH: `pnpm test` runs packages/alchemy-test under Bun, and `typed:check` and `test:stack` use Bun.
- `test:stack`, `dev`, and `deploy` need `GH_APP_ID` and `GH_APP_PRIVATE_KEY` set (read by the pkg registry in `alchemy.run.ts`).
- The pre-commit hook runs `vp staged`, which runs `vp check --fix` on staged files.

## Layout

- `alchemy.run.ts` - the one alchemy stack: a pkg registry Worker. State lives on Cloudflare.
- `apps/` - apps. Empty for now.
- `packages/alchemy-test` - vendored copy of alchemy's test harness. Runs on Bun. See its `VENDORED.md`.
- `tools/anti-slop` - vendored custom oxlint rules, loaded as JS plugins. Tests run with `vp test`.
- `tools/automation` - vendored TypeOnce oxlint rules (Effect, React, xstate, UI), loaded as a JS plugin. See its `POLICY.md`.
- `tools/typed-lint` - vendored type-aware rules oxlint can't express. Config in `typed-lint.config.json`.
- `.agents/skills/effect-program-design` - Effect design skill for agents. `.claude` is a symlink to `.agents`.
- `.vscode/` - oxc as formatter, format and fix-all on save.
- `tooling/` - config modules for `vite.config.ts`: `ignores.ts` (fmt and lint ignores), `lint/anti-slop.ts`, `lint/automation.ts`, `lint/builtin.ts` (oxlint categories and core rules), `lint/tailwind.ts` (better-tailwindcss), `lint/effect-tsgo.ts`, `lint/overrides.ts`, `lint/types.ts`.
- `test/` - root stack tests, run by `test:stack`, not by `pnpm test`.
- `vite.config.ts` - fmt, lint, test, and task runner config.
- `pnpm-workspace.yaml` - workspaces (`apps/*`, `packages/*`, `tools/*`) and the version catalog.

## Conventions and gotchas

- Add deps as `"catalog:"` and pin the version in the `pnpm-workspace.yaml` catalog.
- Import Effect modules as namespaces: `import * as Effect from "effect/Effect"`.
- Write relative imports without an extension (`./foo`, not `./foo.ts`). Resolution is `bundler`; lint rule `import/extensions` enforces it.
- Write Effect tests with `it.effect` from `@effect/vitest`.
- Lint treats every `@effect/tsgo` diagnostic and every anti-slop and automation rule as an error. Fix the code; don't disable the rule.
- Put per-package lint overrides in `tooling/lint/overrides.ts`, not in a package's `vite.config.ts`.
- `pnpm install` runs `prepare`, which patches TypeScript (`effect-tsgo patch --oxlint`). Lint needs that patch.
- fmt, lint, and typecheck skip `packages/alchemy-test`, `tools/anti-slop`, `tools/automation`, and `tools/typed-lint` (`tooling/ignores.ts`). Typecheck also skips the rest of `packages/*` and `tools/*`.
- A new app needs its own `tsconfig.json` (extend `../../tsconfig.json`) to get type checked, and a `test` script to run under `pnpm test`.
- Keep `packages/alchemy-test` close to upstream and log any local change in its `VENDORED.md`.
- `tools/anti-slop`, `tools/automation`, and `tools/typed-lint` are ours to change; edit rules in place and note the change in the tool's `VENDORED.md`.

## Rules turned off

Ask before turning off any other rule.

- `effecttsgo/missing-pipeable-signature`: demands Effect-style data-last overloads on every exported multi-argument function.
- `effecttsgo/unstable-api-usage` and `effecttsgo/api-stability-leak`: we build on Effect APIs marked unstable (`effect/http`, `@effect/vitest`, alchemy).
- `vitest/no-standalone-expect` in `*.test.ts`: `@effect/vitest` and alchemy's harness call `expect` inside Effects.
- Built-ins set to `off` in `tooling/lint/builtin.ts` (`require-yield`, `no-shadow`, and others): kept from the TypeOnce policy; see `tools/automation/POLICY.md`.
