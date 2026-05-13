import { runMcpServer } from "./mcp/server.js";

runMcpServer().catch((error) => {
  console.error("[memory-router] failed to start MCP server:", error);
  process.exit(1);
});
