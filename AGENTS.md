# AGENTS.md

pnpm monorepo on Vite+ (`vite-plus`, CLI `vp`). TypeScript, Effect v4, alchemy v2 beta on Cloudflare.

## Commands

Run `pnpm check` before you finish any change.

```sh
pnpm check         # format (writes), lint, typecheck,type-aware linting; stops at first failure
pnpm ready         # check, then test
pnpm format        # oxfmt, writes files
pnpm lint          # oxlint with type-aware rules; does not type check
pnpm lint:fix
pnpm typecheck     # `vp run -r typecheck` (every package's `typecheck` script, 4 at a time), then tsrs at the root
pnpm typed:check   # typed-lint: TypeScript-API rules from typed-lint.config.json (Bun)
pnpm test          # `vp run -r test`: every package's `test` script
pnpm build:packages  # build the fold packages' publishable dist/ (Bun); preview-packages runs it before pkg pack
pnpm build:binaries  # compile the native foldcode binary for all 12 targets into dist/ (Bun); --host for this machine only

pnpm test:stack    # test/stack.test.ts: runs the alchemy stack in local workerd (Bun)
pnpm test:conformance  # Durable Streams conformance suite against the Worker in local workerd
```

- `vp run <script>` runs any root script.
- One package's tests: `vp run <pkg>#test` or `vp run --filter <pkg> test`.
- `vp run` caches results. Pass `--no-cache` to force a run.
- Built-in `vp check` does not type check (lint `typeCheck` is off). Use `pnpm check`.
- Bun must be on PATH: `pnpm test` runs packages/alchemy-test under Bun, and `typed:check` and `test:stack` use Bun.
- `test:stack`, `alchemy:dev`, and `alchemy:deploy` read `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `STEGOSAURUS_GITHUB_WEBHOOK_SECRET` and `STEGOSAURUS_OPENAI_API_KEY` from Infisical (see Secrets).
- `pnpm alchemy:deploy` deploys stage `prod`. Deploy a personal stage with `pnpm exec alchemy deploy` (defaults to `live_$USER`).
- The pre-commit hook runs `vp staged`, which runs `vp check --fix` on staged files.
- Opt-in tests: fold-cli's real-terminal TUI tests run only with `FOLD_TUI_TERMINAL_TEST=1` and never when `CI` is set (`vp run @stegosaurus/fold-cli#test:tui`, needs Bun), and fold-agent's live Codex tests only with `FOLD_CODEX_LIVE=1`.

## Secrets

- The stack's `secrets` option in `alchemy.run.ts` loads config from Infisical. Set the project ID in `INFISICAL_PROJECT`.
- Stage `prod` reads Infisical environment `prod`. Every other stage (`dev_$USER`, `live_$USER`, `test_$USER`) reads `dev`.
- Outside `prod`, a local `.env` overrides Infisical. Shell variables override both.
- `--env-file` fails on this stack. List the file with `Alchemy.Secrets.DotEnv({ path })` instead.
- Ask user to log in locally with infisical CLI

## Domains

- Prod Workers use custom domains on `stegosaurus.tech`, such as `api.stegosaurus.tech`. Set the Worker `domain` prop with `zoneName: "stegosaurus.tech"`, and set `workersDev: false`.
- Every other stage uses workers.dev at `<name>-<stage>.stegosaurus.workers.dev`. workers.dev allows one label before the account subdomain, so put the stage in the Worker name, lowercased, with `_` replaced by `-`.
- The pkg registry runs only in `prod`, at `pkg.stegosaurus.tech`.

## Layout

- `alchemy.run.ts` - the one alchemy stack: Secrets Store copies of the GitHub App secrets and the agent in every stage, plus the pkg registry Worker in `prod`. State lives on Cloudflare.
- `apps/agent` - the GitHub coding agent (`@stegosaurus/agent`), from channels' `examples/alchemy-cloudflare`: an Ingress Worker (webhooks, delivery, session Durable Objects) and a Computer Worker (`@cloudflare/computer` workspaces with a container, from the K-Mistele/computer fork). The root stack yields it in every stage, under the `Agent` namespace. Prod serves `agent.stegosaurus.tech`.
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
- `tooling/` - config modules for `vite.config.ts`: `ignores.ts` (fmt and lint ignores), `lint/anti-slop.ts`, `lint/automation.ts`, `lint/builtin.ts` (oxlint categories and core rules), `lint/tailwind.ts` (better-tailwindcss), `lint/effect-tsgo.ts`, `lint/overrides.ts`, `lint/types.ts`.
- `test/` - root stack tests, run by `test:stack`, not by `pnpm test`.
- `vite.config.ts` - fmt, lint, test, and task runner config.

## Conventions and gotchas

- Add deps as `"catalog:"` and pin the version in the `pnpm-workspace.yaml` catalog.
- Import Effect modules as namespaces: `import * as Effect from "effect/Effect"`.
- Write relative imports without an extension (`./foo`, not `./foo.ts`). Resolution is `bundler`; lint rule `import/extensions` enforces it.
- Write Effect tests with `it.effect` from `@effect/vitest`.
- Lint treats every `@effect/tsgo` diagnostic and every anti-slop and automation rule as an error. Fix the code; don't disable the rule.
- use the `effect-program-design` skill when working on effect code for best practices; when in doubt (or if it conflicts with rules), ask the user
- Put per-package lint overrides in `tooling/lint/overrides.ts`, not in a package's `vite.config.ts`.
- Typecheck runs tsrs (oxc's Rust port of the TypeScript 7 compiler), not `tsc`: same errors and `.d.ts` output, about 3x faster with less than half the memory. It reads the same tsconfigs and takes `tsc`'s flags (`tsrs -p <dir>`). The `typescript` package stays for the editor and for effect-tsgo. Effect diagnostics run only in lint, so tsrs loses none.
- `pnpm install` runs `prepare`, which patches TypeScript (`effect-tsgo patch --oxlint`). Lint needs that patch.
- fmt and lint skip `packages/alchemy-test`, `packages/effect-ai-*`, `tools/anti-slop`, `tools/automation`, and `tools/typed-lint` (`tooling/ignores.ts`). Typecheck skips any package without a `typecheck` script; `alchemy-test` and `anti-slop` have one. Lint alone also skips `packages/fold-cli`, `packages/fold-tui-theme` and `packages/fold` (an install script that runs before any dependency exists). `typed:check` skips `effect-ai-*`, `fold-cli` and `fold-tui-theme` too (`typed-lint.config.json`).
- A new app or package needs a `tsconfig.json` (extend `../../tsconfig.json`) and a `"typecheck": "tsrs"` script to get type checked, and a `test` script to run under `pnpm test`.
- Keep `packages/alchemy-test` close to upstream and log any local change in its `VENDORED.md`.
- `tools/anti-slop`, `tools/automation`, and `tools/typed-lint` are ours to change; edit rules in place and note the change in the tool's `VENDORED.md`.

