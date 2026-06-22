import { listStaticResources, readStaticResource } from "../mcp/server.js";
import { getCallableToolEntries, getExposedToolEntries } from "../mcp/tools/index.js";

type DispatchRequest = {
  method: string;
  params?: Record<string, unknown>;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorResult(message: string) {
  return {
    content: [{ type: "text", text: `[TOOL_ERROR] ${message}` }],
    isError: true,
  };
}

async function dispatch(request: DispatchRequest): Promise<unknown> {
  switch (request.method) {
    case "tools/list":
      return {
        tools: getExposedToolEntries().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };

    case "tools/call": {
      const name = typeof request.params?.name === "string" ? request.params.name : "";
      const tool = getCallableToolEntries().find((entry) => entry.name === name);
      if (!tool) return errorResult(`Unknown tool: ${name}`);
      return await tool.handler(request.params?.arguments, {
        requestMeta:
          request.params?._meta && typeof request.params._meta === "object"
            ? (request.params._meta as Record<string, unknown>)
            : undefined,
        toolName: name,
      });
    }

    case "resources/list":
      return { resources: listStaticResources() };

    case "resources/read": {
      const uri = typeof request.params?.uri === "string" ? request.params.uri : "";
      return await readStaticResource(uri);
    }

    default:
      return errorResult(`Unknown MCP dispatch method: ${request.method}`);
  }
}

try {
  const raw = await readStdin();
  const request = JSON.parse(raw || "{}") as DispatchRequest;
  const result = await dispatch(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(errorResult(error instanceof Error ? error.message : String(error)))}\n`,
  );
}
