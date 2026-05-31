export function buildMcpConfigSnippet(cwd: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "context-still": {
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
