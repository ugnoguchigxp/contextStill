import path from "node:path";
import devServer from "@hono/vite-dev-server";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { adminDevServerPort } from "./src/dev-server.config.js";

export default defineConfig({
  plugins: [
    tailwindcss(),
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
      "@": path.resolve(__dirname, "./web/src"),
      "@web": path.resolve(__dirname, "./web/src"),
      "@api": path.resolve(__dirname, "./api"),
    },
  },
  server: {
    port: adminDevServerPort,
    strictPort: true,
  },
  optimizeDeps: {
    include: ["dayjs", "@braintree/sanitize-url"],
    exclude: ["markdown-wysiwyg-editor", "mermaid"],
  },
  build: {
    outDir: "dist-web",
  },
});
