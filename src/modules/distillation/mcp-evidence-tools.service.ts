import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { groupedConfig } from "../../config.js";
import type { DistillationToolResult } from "./distillation-tools.service.js";

export type DistillationMcpToolName = "context7" | "deepwiki";

type McpEvidenceServerConfig = {
  command: string;
  args: string[];
  cwd?: string;
  toolName: string;
};

function envKey(toolName: DistillationMcpToolName, suffix: string): string {
  return `CONTEXT_STILL_${toolName.toUpperCase()}_MCP_${suffix}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry));
    }
  } catch {
    // Fall through to whitespace splitting for simple local configuration.
  }
  return raw
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function resolveServerConfig(toolName: DistillationMcpToolName): McpEvidenceServerConfig | null {
  const command = process.env[envKey(toolName, "COMMAND")]?.trim();
  if (!command) return null;
  return {
    command,
    args: parseArgs(process.env[envKey(toolName, "ARGS")]),
    cwd: stringValue(process.env[envKey(toolName, "CWD")]),
    toolName: process.env[envKey(toolName, "TOOL")]?.trim() || toolName,
  };
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (
      record.type === "resource" &&
      record.resource &&
      typeof record.resource === "object"
    ) {
      const resource = record.resource as Record<string, unknown>;
      if (typeof resource.text === "string") parts.push(resource.text);
      if (typeof resource.uri === "string") parts.push(`resource: ${resource.uri}`);
    } else if (record.type === "resource_link" && typeof record.uri === "string") {
      parts.push(`resource: ${record.uri}`);
    }
  }
  return parts.join("\n").trim();
}

function firstContentUri(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "resource" && record.resource && typeof record.resource === "object") {
      const uri = stringValue((record.resource as Record<string, unknown>).uri);
      if (uri) return uri;
    }
    if (record.type === "resource_link") {
      const uri = stringValue(record.uri);
      if (uri) return uri;
    }
  }
  return undefined;
}

function metadataFromMcpResult(result: Record<string, unknown>, toolName: DistillationMcpToolName) {
  const structured =
    result.structuredContent && typeof result.structuredContent === "object"
      ? (result.structuredContent as Record<string, unknown>)
      : {};
  const meta =
    result._meta && typeof result._meta === "object"
      ? (result._meta as Record<string, unknown>)
      : {};
  return {
    server: toolName,
    uri:
      stringValue(structured.uri) ??
      stringValue(meta.uri) ??
      stringValue(structured.url) ??
      firstContentUri(result.content),
    title: stringValue(structured.title) ?? stringValue(meta.title),
    locator: stringValue(structured.locator) ?? stringValue(meta.locator),
    mcpToolName: stringValue(structured.toolName) ?? stringValue(meta.toolName),
  };
}

function unavailableResult(
  toolName: DistillationMcpToolName,
  error: string,
): DistillationToolResult {
  return {
    callId: "",
    name: toolName,
    ok: false,
    content: JSON.stringify({
      error,
      instruction: "Treat this MCP result as unavailable optional evidence.",
    }),
    metadata: {
      server: toolName,
      unavailable: true,
    },
    error,
  };
}

export async function executeMcpEvidenceTool(
  toolName: DistillationMcpToolName,
  args: Record<string, unknown>,
): Promise<DistillationToolResult> {
  const config = resolveServerConfig(toolName);
  if (!config) {
    return unavailableResult(
      toolName,
      `${toolName} MCP server is not configured (${envKey(toolName, "COMMAND")})`,
    );
  }

  const client = new Client({
    name: "context-still-distillation",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: inheritedEnvironment(),
    stderr: "pipe",
  });

  try {
    await client.connect(transport, {
      timeout: groupedConfig.distillationTools.timeoutMs,
    });
    const result = (await client.callTool(
      {
        name: config.toolName,
        arguments: args,
      },
      undefined,
      {
        timeout: groupedConfig.distillationTools.timeoutMs,
      },
    )) as Record<string, unknown>;
    const content = contentToText(result.content) || JSON.stringify(result.structuredContent ?? {});
    const isError = Boolean(result.isError);
    return {
      callId: "",
      name: toolName,
      ok: !isError,
      content,
      metadata: {
        ...metadataFromMcpResult(result, toolName),
        mcpToolName: config.toolName,
      },
      error: isError ? content || `${toolName} MCP tool returned an error` : undefined,
    };
  } catch (error) {
    return unavailableResult(toolName, error instanceof Error ? error.message : String(error));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
