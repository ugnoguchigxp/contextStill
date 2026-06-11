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
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts", "web/src/**/*.{ts,tsx}"],
      exclude: [
        "src/cli/**",
        "src/db/migrations/**",
        "src/db/seed.ts",
        "src/index.ts",
        "src/config.ts",
        "src/db/client.ts",
        "src/db/index.ts",
        "src/mcp/registry.ts",

        "web/src/main.tsx",
        "web/src/App.tsx",
        "web/src/smoke.test.ts",
        "web/src/**/*.page.tsx",
        "web/src/modules/**/*page.tsx",
      ],
    },
  } as any,
});
