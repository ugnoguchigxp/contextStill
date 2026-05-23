export function buildMcpConfigSnippet(cwd: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "memory-router": {
          command: "bun",
          args: ["run", "start:mcp"],
          cwd,
        },
      },
    },
    null,
    2,
  );
}
