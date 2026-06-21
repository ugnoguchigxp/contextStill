import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getCompileRunSnapshot,
  getLatestCompileRunSnapshot,
  listRecentCompileRuns,
} from "../modules/context-compiler/context-compiler.repository.js";
import { runDoctor } from "../modules/doctor/doctor.service.js";
import { mcpResourceUri, normalizeMcpResourceUri, projectIdentity } from "../project-identity.js";
import { getCallableToolEntries, getExposedToolEntries } from "./tools/index.js";

export type McpServerCloseReason =
  | "mcp_transport_closed"
  | "stdio_closed"
  | "stdio_ended"
  | "stdio_error"
  | "runtime_close";

export type McpServerRuntime = {
  close: () => Promise<void>;
  closed: Promise<{ reason: McpServerCloseReason; error?: Error }>;
};

export type RunMcpServerOptions = {
  stdin?: Readable;
  stdout?: Writable;
};

function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `[TOOL_ERROR] ${message}` }],
    isError: true,
  };
}

const staticResources: Resource[] = [
  {
    name: "context-compiler-summary",
    uri: mcpResourceUri("summary/context-compiler"),
    description: "contextStill Context Compiler summary and retrieval modes.",
    mimeType: "text/plain",
  },
  {
    name: "context-pack-runs-list",
    uri: mcpResourceUri("packs/list"),
    description: "Recent context_compile run summaries.",
    mimeType: "application/json",
  },
  {
    name: "context-pack-latest",
    uri: mcpResourceUri("packs/latest"),
    description: "Latest context_compile run with selected items.",
    mimeType: "application/json",
  },
  {
    name: "doctor-health",
    uri: mcpResourceUri("health/doctor"),
    description: "Doctor health report including DB, table, and run-health diagnostics.",
    mimeType: "application/json",
  },
];

function buildSummaryText(): string {
  return [
    "# contextStill context compiler",
    "",
    "- tool: context_compile",
    "- retrieval modes: task_context, review_context, debug_context, architecture_context, procedure_context, learning_context",
    "- instructions are selected from active knowledge by default",
    "- source refs are stored per selected pack item and at pack-level",
  ].join("\n");
}

function asJsonContent(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  };
}

function asTextContent(uri: string, text: string) {
  return {
    contents: [{ uri, mimeType: "text/plain", text }],
  };
}

export function listStaticResources(): Resource[] {
  return [...staticResources];
}

export async function readStaticResource(uri: string) {
  const canonicalUri = normalizeMcpResourceUri(uri);

  if (canonicalUri === mcpResourceUri("summary/context-compiler")) {
    return asTextContent(uri, buildSummaryText());
  }

  if (canonicalUri === mcpResourceUri("packs/list")) {
    const runs = await listRecentCompileRuns(20);
    return asJsonContent(uri, { runs });
  }

  if (canonicalUri === mcpResourceUri("packs/latest")) {
    const snapshot = await getLatestCompileRunSnapshot();
    if (!snapshot) {
      return asJsonContent(uri, { message: "No context_compile run found yet." });
    }
    return asJsonContent(uri, snapshot);
  }

  if (canonicalUri === mcpResourceUri("health/doctor")) {
    const doctor = await runDoctor();
    return asJsonContent(uri, doctor);
  }

  const runPrefix = mcpResourceUri("packs/run/");
  if (canonicalUri.startsWith(runPrefix)) {
    const runId = canonicalUri.replace(runPrefix, "").trim();
    if (!runId) {
      return asJsonContent(uri, { error: "run id is required" });
    }
    const snapshot = await getCompileRunSnapshot(runId);
    if (!snapshot) {
      return asJsonContent(uri, { error: "run not found", runId });
    }
    return asJsonContent(uri, snapshot);
  }

  return asJsonContent(uri, { error: "resource not found", uri });
}

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: projectIdentity.packageName,
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getExposedToolEntries().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })) as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = getCallableToolEntries().find((entry) => entry.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    try {
      return await tool.handler(request.params.arguments, {
        requestMeta:
          request.params._meta && typeof request.params._meta === "object"
            ? (request.params._meta as Record<string, unknown>)
            : undefined,
        toolName: request.params.name,
      });
    } catch (error) {
      return toErrorResult(error);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listStaticResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readStaticResource(request.params.uri),
  );

  return server;
}

export async function runMcpServer(options: RunMcpServerOptions = {}): Promise<McpServerRuntime> {
  const server = createMcpServer();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);

  let closing = false;
  let resolveClosed: (value: { reason: McpServerCloseReason; error?: Error }) => void = () => {};
  const closed = new Promise<{ reason: McpServerCloseReason; error?: Error }>((resolve) => {
    resolveClosed = resolve;
  });

  const removeStdioListeners = () => {
    stdin.off("close", onStdioClose);
    stdin.off("end", onStdioEnd);
    stdin.off("error", onStdioError);
  };

  const closeRuntime = async (reason: McpServerCloseReason, error?: Error): Promise<void> => {
    if (closing) return;
    closing = true;
    removeStdioListeners();
    try {
      await server.close();
    } finally {
      resolveClosed(error ? { reason, error } : { reason });
    }
  };

  const onStdioClose = () => {
    void closeRuntime("stdio_closed");
  };
  const onStdioEnd = () => {
    void closeRuntime("stdio_ended");
  };
  const onStdioError = (error: Error) => {
    void closeRuntime("stdio_error", error);
  };

  stdin.once("close", onStdioClose);
  stdin.once("end", onStdioEnd);
  stdin.once("error", onStdioError);

  server.onclose = () => {
    void closeRuntime("mcp_transport_closed");
  };

  await server.connect(transport);

  return {
    close: () => closeRuntime("runtime_close"),
    closed,
  };
}
