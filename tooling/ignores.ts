/** Paths that lint and format both skip. */
export const ignorePatterns = [
  // Agent tooling
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".humanlayer/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  // Vendored code, kept close to upstream
  "packages/alchemy-test/**",
  "tools/anti-slop/**",
];
