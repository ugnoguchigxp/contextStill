import { defineConfig } from "@playwright/test";
import { adminDevServerOrigin } from "./src/dev-server.config.js";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: {
    baseURL: adminDevServerOrigin,
    trace: "on-first-retry",
  },
  webServer: {
    command: "bun run dev",
    url: adminDevServerOrigin,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
