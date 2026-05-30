import { runMcpServer } from "./mcp/server.js";
import { closeDbPool } from "./db/client.js";

runMcpServer().catch((error) => {
  console.error("[memory-router] failed to start MCP server:", error);
  process.exit(1);
});

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\nReceived ${signal} in MCP server. Shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.error("MCP server graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 10_000);

  try {
    console.log("Closing MCP server database connection pool...");
    await closeDbPool();
    console.log("MCP server shutdown complete.");
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    console.error("Error during MCP server shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
