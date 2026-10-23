import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["**/node_modules/**", "src/rules/require-readable-spacing-cli.test.ts"],
  },
});
