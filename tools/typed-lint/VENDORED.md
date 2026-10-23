# Vendored: typed-lint

- Source: https://github.com/humanlayer/typescript-monorepo-template, `tools/typed-lint`
- Template commit: d49b5894004679cb82c311ec486eecd08b718afb (2026-10-02)
- Upstream of that copy: https://github.com/typeonce-dev/ai-automation at 0bca096fe6fe9878cd15303a623dd2cd85915ddd

Copied unchanged. Config lives in `/typed-lint.config.json`. Run with `pnpm typed:check` (Bun runs the TypeScript directly; the template used `tsx`). It uses the TypeScript 5.9 compiler API through the `typescript-api` alias, since TypeScript 7 has no JS API.

This copy is ours to change.
