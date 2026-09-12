import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    include: [
      "web/src/**/*.test.ts",
      "web/src/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
    ],
    setupFiles: ["test/setup.ts"],
    environmentMatchGlobs: [
      ["test/components/**", "jsdom"],
      ["web/src/**", "jsdom"],
    ],
    globals: true,
    alias: {
      "@": path.resolve(__dirname, "./web/src"),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "lcov", "html"],
      reportsDirectory: path.join(
        process.env.CONTEXT_STILL_COVERAGE_DIR ?? "artifacts/coverage",
        "vitest",
      ),
      include: ["src/**/*.{ts,tsx}", "api/**/*.ts", "web/src/**/*.{ts,tsx}"],
      // Declarations and test sources contain no production behavior. Runtime-specific code
      // remains in the denominator, and Bun native coverage is reported separately.
      exclude: ["**/*.d.ts", "**/*.test.{ts,tsx}", "src/db/migrations/**"],
    },
  } as any,
});
