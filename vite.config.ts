import path from "node:path";
import devServer from "@hono/vite-dev-server";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: "api/app.ts",
      // Only /api requests are handled by Hono; everything else is Vite/React.
      exclude: [/^\/(?!api(?:\/|$)).*/],
      injectClientScript: false,
    }),
  ],
  resolve: {
    alias: {
      "@web": path.resolve(__dirname, "./web/src"),
      "@api": path.resolve(__dirname, "./api"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist-web",
  },
});
