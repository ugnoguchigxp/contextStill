export function resolveDefaultMcpEndpointUrl(): string {
  const host = process.env.CONTEXT_STILL_MCP_HOST || "127.0.0.1";
  const port = process.env.CONTEXT_STILL_MCP_PORT || "39172";
  return `http://${host}:${port}/mcp`;
}

export function buildMcpConfigSnippet(_cwd: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "context-still": {
          url: resolveDefaultMcpEndpointUrl(),
          enabled: true,
        },
      },
    },
    null,
    2,
  );
}
