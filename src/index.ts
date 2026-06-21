import { closeDbPool } from "./db/client.js";
import { type McpServerRuntime, runMcpServer } from "./mcp/server.js";
import { projectIdentity } from "./project-identity.js";

let shuttingDown = false;
let mcpRuntime: McpServerRuntime | null = null;

const shutdown = async (reason: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.error(`\nReceived ${reason} in MCP server. Shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.error("MCP server graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 10_000);

  try {
    if (mcpRuntime) {
      console.error("Closing MCP stdio transport...");
      await mcpRuntime.close();
    }
    console.error("Closing MCP server database connection pool...");
    await closeDbPool();
    console.error("MCP server shutdown complete.");
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  } catch (error) {
    clearTimeout(forceExitTimer);
    console.error("Error during MCP server shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

runMcpServer()
  .then((runtime) => {
    mcpRuntime = runtime;
    runtime.closed.then(({ reason, error }) => {
      if (error) {
        console.error(`[${projectIdentity.packageName}] MCP stdio closed with error:`, error);
      }
      void shutdown(reason, error ? 1 : 0);
    });
  })
  .catch((error) => {
    console.error(`[${projectIdentity.packageName}] failed to start MCP server:`, error);
    process.exit(1);
  });
