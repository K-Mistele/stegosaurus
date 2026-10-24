export const ignorePatterns = [
    '.agent/**',
    '.agents/**',
    '.claude/**',
    '.codex/**',
    '.continue/**',
    '.cursor/**',
    '.gemini/**',
    '.humanlayer/**',
    '.opencode/**',
    '.pi/**',
    '.roo/**',
    '.windsurf/**',
    'packages/alchemy-test/**',
    'packages/effect-ai-anthropic/**',
    'packages/effect-ai-openai/**',
    'packages/effect-ai-openai-compat/**',
    'tools/anti-slop/**',
    'tools/automation/**',
    'tools/typed-lint/**',
];

// Lint-only skips: fold-cli and its fold-tui-theme dependency, moved from github.com/humanlayer/fold as is.
// packages/fold runs at npm install time, before any dependency (Effect included) exists.
export const lintIgnorePatterns = [
    ...ignorePatterns,
    'packages/fold-cli/**',
    'packages/fold-tui-theme/**',
    'packages/fold/**',
];
