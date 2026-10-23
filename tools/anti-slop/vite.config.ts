import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Oxlint's RuleTester registers cases through global `describe`/`it`.
    globals: true,
  },
});
