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
pnpm typecheck     # tsc at the root, then `vp run -r typecheck`: every package's `typecheck` script, 4 at a time
pnpm typed:check   # typed-lint: TypeScript-API rules from typed-lint.config.json (Bun)
pnpm test          # `vp run -r test`: every package's `test` script
pnpm build:packages  # build the fold packages' publishable dist/ (Bun); preview-packages runs it before pkg pack
pnpm build:binaries  # compile the native foldcode binary for all 12 targets into dist/ (Bun); --host for this machine only
pnpm release:prepare --version x.y.z   # stage the npm release in .release/ (libraries, native packages, @stegosaurus/fold)
pnpm release:validate --version x.y.z  # check the staged release, including fresh npm and pnpm consumer installs
pnpm release:publish --version x.y.z   # npm publish each staged package (--dry-run to try it)
pnpm test:stack    # test/stack.test.ts: runs the alchemy stack in local workerd (Bun)
pnpm test:conformance  # Durable Streams conformance suite against the Worker in local workerd
pnpm test:backends     # channels Postgres and Redis suites against throwaway Docker containers (Bun, local Unix-socket Docker)
pnpm alchemy:dev       # alchemy dev
pnpm alchemy:deploy    # alchemy deploy --stage prod (not `pnpm deploy`, a pnpm built-in)
pnpm alchemy:destroy   # alchemy destroy
```

- `vp run <script>` runs any root script.
- One package's tests: `vp run <pkg>#test` or `vp run --filter <pkg> test`.
- `vp run` caches results. Pass `--no-cache` to force a run.
- Built-in `vp check` does not type check (lint `typeCheck` is off). Use `pnpm check`.
- Bun must be on PATH: `pnpm test` runs packages/alchemy-test under Bun, and `typed:check` and `test:stack` use Bun.
- `test:stack`, `alchemy:dev`, and `alchemy:deploy` read `GH_APP_ID` and `GH_APP_PRIVATE_KEY` from Infisical (see Secrets).
- `pnpm alchemy:deploy` deploys stage `prod`. Deploy a personal stage with `pnpm exec alchemy deploy` (defaults to `live_$USER`).
- The pre-commit hook runs `vp staged`, which runs `vp check --fix` on staged files.
- Opt-in tests: fold-cli's real-terminal TUI tests run only with `FOLD_TUI_TERMINAL_TEST=1` and never when `CI` is set (`vp run @stegosaurus/fold-cli#test:tui`, needs Bun), and fold-agent's live Codex tests only with `FOLD_CODEX_LIVE=1`.

## Secrets

- The stack's `secrets` option in `alchemy.run.ts` loads config from Infisical. Set the project ID in `INFISICAL_PROJECT`.
- Stage `prod` reads Infisical environment `prod`. Every other stage (`dev_$USER`, `live_$USER`, `test_$USER`) reads `dev`.
- Outside `prod`, a local `.env` overrides Infisical. Shell variables override both.
- `--env-file` fails on this stack. List the file with `Alchemy.Secrets.DotEnv({ path })` instead.
- Log in locally with an Infisical machine identity (Universal Auth). Pipe in the client secret to keep it out of shell history:
  `printf %s "$SECRET" | pnpm exec alchemy profile edit --add Infisical --method universal-auth --set clientId=<client-id> --set clientSecret=-`
  Run `pnpm exec alchemy profile edit --add Infisical` to be prompted instead.
- CI logs in with GitHub OIDC: set `INFISICAL_IDENTITY_ID` and grant `id-token: write`. `INFISICAL_TOKEN` also works.
- The stack copies both values into the Cloudflare account's Secrets Store as `GH_APP_ID_<stage>` and `GH_APP_PRIVATE_KEY_<stage>`. Bind those in new Workers. The pkg registry still gets plain Worker secrets.

## Domains

- Prod Workers use custom domains on `stegosaurus.tech`, such as `api.stegosaurus.tech`. Set the Worker `domain` prop with `zoneName: "stegosaurus.tech"`, and set `workersDev: false`.
- Every other stage uses workers.dev at `<name>-<stage>.stegosaurus.workers.dev`. workers.dev allows one label before the account subdomain, so put the stage in the Worker name, lowercased, with `_` replaced by `-`.
- The pkg registry runs only in `prod`, at `pkg.stegosaurus.tech`.

## Layout

- `alchemy.run.ts` - the one alchemy stack: Secrets Store copies of the GitHub App secrets in every stage, plus the pkg registry Worker in `prod`. State lives on Cloudflare.
- `apps/` - apps. Empty for now.
- `packages/durable-streams-*` - Durable Streams server, from github.com/K-Mistele/durable-object-durable-streams: `protocol` (wire schemas), `server` (protocol engine), `cloudflare` (Workers + Durable Objects host, with its own local-state stack in `alchemy.run.ts`), and empty `cluster` and `client` stubs.
- `packages/channels-*` - Channels, copied from github.com/humanlayer/channels at 9b74803 (MIT, `LICENSE` in each package): `delivery` (mailbox delivery engine and `DeliveryHttpApi`; every other package depends on it), the `github`, `linear` and `slack` providers, `redis` and `sql` backends, and `alchemy-cloudflare` (Durable Object mailbox host). The `sql` and `redis` suites in `test-backends/` need Postgres and Redis, so `pnpm test` skips them; run `pnpm test:backends`.
- `scripts/` - root scripts. `test-backends.ts` starts the channels backend containers and runs their suites.
- `patches/` - pnpm patches, listed under `patchedDependencies` in `pnpm-workspace.yaml`. Edit one with `pnpm patch <pkg>@<version>`, then `pnpm patch-commit <dir>`. The conformance-suite patch lets its SSE tests accept `data: ` (upstream PR #285).
- `packages/alchemy-test` - vendored copy of alchemy's test harness. Runs on Bun. See its `VENDORED.md`.
- `packages/effect-ai-{anthropic,openai,openai-compat}` - vendored Effect AI providers with fold's fixes. Each `UPSTREAM.md` lists the source and local changes. Their `typecheck` also writes `.d.ts` files to `dist/`, which consumers type against, so `vp run -r` must build them first.
- `packages/fold-*` and `packages/effect-branded-id` - the fold agent runtime, from github.com/humanlayer/fold: `core` (agent loop, tools, event log), `agent` (coding tools, config, sessions), `codex`, `opencode` and `xai` (provider auth and models), `cli` (Node CLI and TUI), and `tui-theme` (the TUI's themes). The workspace imports their `src/`; published tarballs carry `dist/`, which `publishConfig` points at (built by `packages/fold-cli/scripts/build-packages.ts`, ported from fold).
- `packages/fold` - the `@stegosaurus/fold` npm wrapper: its postinstall copies the matching native `foldcode` binary from one of the `@stegosaurus/fold-<os>-<cpu>` packages. Private in the workspace; `release:prepare` stages the public version.
- Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which checks, tests, builds, stages, validates and publishes to npm, as fold does. The scripts live in `packages/fold-cli/scripts/` (ported from fold's `scripts/`). Publishing uses npm trusted publishing. A package must exist on npm before it can be trusted, so publish its first version from a logged-in machine (`pnpm release:publish --tag rc`), then point trusted publishing at `release.yml` once with `bun packages/fold-cli/scripts/release/trust.ts` (2FA).
- `tools/anti-slop` - vendored custom oxlint rules, loaded as JS plugins. Tests run with `vp test`.
- `tools/automation` - vendored TypeOnce oxlint rules (Effect, React, xstate, UI), loaded as a JS plugin. See its `POLICY.md`.
- `tools/typed-lint` - vendored type-aware rules oxlint can't express. Config in `typed-lint.config.json`.
- `.agents/skills/effect-program-design` - Effect design skill for agents. `.claude` is a symlink to `.agents`.
- `.agents/skills/create-{research-questions,research,design-discussion,structure-outline}` - RPI skills, copied from riptide-rpi 0.41.3. They call the helper agents in `.agents/agents` (from the riptide daemon in `~/projects/synclayer`).
- `.agents/skills/show-me` - visual explainer skill, copied from riptide-humanlayer 0.1.8.
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
- fmt and lint skip `packages/alchemy-test`, `packages/effect-ai-*`, `tools/anti-slop`, `tools/automation`, and `tools/typed-lint` (`tooling/ignores.ts`). Typecheck skips any package without a `typecheck` script; `alchemy-test` and `anti-slop` have one. Lint alone also skips `packages/fold-cli`, `packages/fold-tui-theme` and `packages/fold` (an install script that runs before any dependency exists). `typed:check` skips `effect-ai-*`, `fold-cli` and `fold-tui-theme` too (`typed-lint.config.json`).
- A new app or package needs a `tsconfig.json` (extend `../../tsconfig.json`) and a `"typecheck": "tsc"` script to get type checked, and a `test` script to run under `pnpm test`.
- Keep `packages/alchemy-test` close to upstream and log any local change in its `VENDORED.md`.
- `tools/anti-slop`, `tools/automation`, and `tools/typed-lint` are ours to change; edit rules in place and note the change in the tool's `VENDORED.md`.

## Rules turned off

Ask before turning off any other rule.

- `effecttsgo/missing-pipeable-signature`: demands Effect-style data-last overloads on every exported multi-argument function.
- `effecttsgo/unstable-api-usage` and `effecttsgo/api-stability-leak`: we build on Effect APIs marked unstable (`effect/http`, `@effect/vitest`, alchemy).
- `automation/no-single-use-private-functions`: demands inlining every helper with one caller, even ones named to keep a long function readable.
- `vitest/no-standalone-expect` in `*.test.ts`: `@effect/vitest` and alchemy's harness call `expect` inside Effects.
- `effecttsgo/strict-effect-provide` in test files and `test/` directories: each test is its own entry point, and a fresh layer per test gives it isolated state.
- `automation/no-reexport-only-modules` in the fold and channels packages' `src/index.ts`: they are the public entry points.
- `effecttsgo/node-builtin-import` and `effecttsgo/new-promise` in fold-codex's and fold-xai's `OAuthFlows.ts`, and `effecttsgo/strict-effect-provide` in their `CodexAuth.ts`/`XaiAuth.ts` and fold-agent's `TitleGenerator.ts`: fixing them is a redesign (an Effect `HttpServer` OAuth callback, a shared title-model client), left for later.
- `effecttsgo/node-builtin-import` in the fold files listed in `tooling/lint/overrides.ts`: they keep plain synchronous `node:path` helpers that callers use outside Effect. Their Effect code uses `Path.Path`.
- `automation/no-service-option` in test files: test fakes check whether a service was provided.
- `vitest/valid-expect` allows a second argument (`maxArgs: 2`): Vitest takes a failure message there.
- Built-ins set to `off` in `tooling/lint/builtin.ts` (`require-yield`, `no-shadow`, and others): kept from the TypeOnce policy; see `tools/automation/POLICY.md`.

## Skills

- `effect-program-design`: guidelines for writing effect code. you should use this skill any time you're working on effect code.
