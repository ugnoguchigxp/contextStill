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
import { getCallableToolEntries, getExposedToolEntries } from "./tools/index.js";

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
    uri: "memory-router://summary/context-compiler",
    description: "Memory Router Context Compiler summary and retrieval modes.",
    mimeType: "text/plain",
  },
  {
    name: "context-pack-runs-list",
    uri: "memory-router://packs/list",
    description: "Recent context_compile run summaries.",
    mimeType: "application/json",
  },
  {
    name: "context-pack-latest",
    uri: "memory-router://packs/latest",
    description: "Latest context_compile run with selected items.",
    mimeType: "application/json",
  },
  {
    name: "doctor-health",
    uri: "memory-router://health/doctor",
    description: "Doctor health report including DB, table, and run-health diagnostics.",
    mimeType: "application/json",
  },
];

function buildSummaryText(): string {
  return [
    "# memory-router context compiler",
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
  if (uri === "memory-router://summary/context-compiler") {
    return asTextContent(uri, buildSummaryText());
  }

  if (uri === "memory-router://packs/list") {
    const runs = await listRecentCompileRuns(20);
    return asJsonContent(uri, { runs });
  }

  if (uri === "memory-router://packs/latest") {
    const snapshot = await getLatestCompileRunSnapshot();
    if (!snapshot) {
      return asJsonContent(uri, { message: "No context_compile run found yet." });
    }
    return asJsonContent(uri, snapshot);
  }

  if (uri === "memory-router://health/doctor") {
    const doctor = await runDoctor();
    return asJsonContent(uri, doctor);
  }

  if (uri.startsWith("memory-router://packs/run/")) {
    const runId = uri.replace("memory-router://packs/run/", "").trim();
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
      name: "memory-router",
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

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
