import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workspace packages expose their TypeScript sources under this condition,
    // so tests run without building dependencies first.
    conditions: ["development"],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
