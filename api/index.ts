import { serve } from "@hono/node-server";
import app from "./app.js";
import { closeDbPool } from "../src/db/client.js";

const port = Number(process.env.PORT ?? 3000);

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`[api] listening on http://localhost:${info.port}`);
  },
);

const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  
  // 新規接続の受付を停止
  server.close();

  try {
    console.log("Closing database connection pool...");
    await closeDbPool();
    console.log("Shutdown complete.");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

