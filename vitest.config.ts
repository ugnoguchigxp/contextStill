import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["web/src/**/*.test.ts", "web/src/**/*.test.tsx", "test/**/*.test.ts"],
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts", "web/src/**/*.{ts,tsx}"],
      exclude: ["src/cli/**", "src/db/migrations/**", "web/src/smoke.test.ts"],
    },
  },
});
