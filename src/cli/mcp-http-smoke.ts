import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function resolveEndpointUrl(): string {
  const explicit = process.env.CONTEXT_STILL_MCP_ENDPOINT_URL;
  if (explicit) return explicit;
  const host = process.env.CONTEXT_STILL_MCP_HOST || "127.0.0.1";
  const port = process.env.CONTEXT_STILL_MCP_PORT || "39172";
  return `http://${host}:${port}/mcp`;
}

async function main(): Promise<void> {
  const endpointUrl = resolveEndpointUrl();
  const transport = new StreamableHTTPClientTransport(new URL(endpointUrl));
  const client = new Client({ name: "context-still-mcp-http-smoke", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    const hasCompile = toolNames.includes("context_compile");
    const hasInitialInstructions = toolNames.includes("initial_instructions");
    const ok = hasCompile && hasInitialInstructions;

    console.log(
      JSON.stringify(
        {
          ok,
          endpointUrl,
          transport: "streamable-http",
          toolCount: toolNames.length,
          requiredTools: {
            context_compile: hasCompile,
            initial_instructions: hasInitialInstructions,
          },
        },
        null,
        2,
      ),
    );

    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        endpointUrl: resolveEndpointUrl(),
        transport: "streamable-http",
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
