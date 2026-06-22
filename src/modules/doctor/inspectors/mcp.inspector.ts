import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { getRequiredPrimaryMcpTools } from "../doctor.constants.js";

type McpConfigFormat = "toml" | "json";

type McpConfigPath = {
  path: string;
  format: McpConfigFormat;
};

function defaultMcpConfigPaths(): McpConfigPath[] {
  return [
    { path: path.join(os.homedir(), ".codex/config.toml"), format: "toml" },
    { path: path.join(os.homedir(), ".gemini/config/mcp_config.json"), format: "json" },
    { path: path.join(os.homedir(), ".gemini/antigravity/mcp_config.json"), format: "json" },
    { path: path.join(os.homedir(), ".gemini/antigravity-ide/mcp_config.json"), format: "json" },
  ];
}

function extractExactTomlTable(content: string, tableName: string): string | null {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\n)\\[${escaped}\\]\\n([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`);
  return pattern.exec(content)?.[2] ?? null;
}

function hasLegacyServerConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const serialized = JSON.stringify(value);
  return (
    Object.hasOwn(value, "command") ||
    serialized.includes("src/index.ts") ||
    serialized.includes("start:mcp") ||
    serialized.includes("src/mcp/stdio-server.ts") ||
    serialized.includes("src/cli/mcp-smoke.ts")
  );
}

function contentHasLegacyMcpConfig(content: string, format: McpConfigFormat): boolean {
  const serverNames = ["context-still", "memory-router"];

  if (format === "json") {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
      return false;
    }
    return serverNames.some((serverName) =>
      hasLegacyServerConfig((mcpServers as Record<string, unknown>)[serverName]),
    );
  }

  return serverNames.some((serverName) => {
    const table = extractExactTomlTable(content, `mcp_servers.${serverName}`);
    if (!table) return false;
    return (
      /\bcommand\s*=/.test(table) ||
      table.includes("src/index.ts") ||
      table.includes("start:mcp") ||
      table.includes("src/mcp/stdio-server.ts") ||
      table.includes("src/cli/mcp-smoke.ts")
    );
  });
}

export function findLegacyMcpConfigWarnings(
  configPaths: McpConfigPath[] = defaultMcpConfigPaths(),
): string[] {
  const warnings: string[] = [];

  for (const config of configPaths) {
    if (!fs.existsSync(config.path)) continue;
    const content = fs.readFileSync(config.path, "utf8");
    if (!contentHasLegacyMcpConfig(content, config.format)) continue;
    warnings.push(
      `MCP config still uses legacy command registration: ${config.path}. Re-run bun run setup:mcp-config to write the daemon endpoint URL.`,
    );
  }

  return warnings;
}

export async function inspectMcpSurface(): Promise<DoctorReport["mcp"]> {
  const { getExposedToolEntries } = await import("../../../mcp/tools/index.js");
  const requiredPrimaryMcpTools = getRequiredPrimaryMcpTools();
  const exposedTools = getExposedToolEntries()
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const missingPrimaryTools = requiredPrimaryMcpTools.filter(
    (name) => !exposedTools.includes(name),
  );
  const nextActions: string[] = [];
  if (missingPrimaryTools.length > 0) {
    nextActions.push(`不足 MCP primary tools を追加する: ${missingPrimaryTools.join(", ")}`);
  }
  nextActions.push(...findLegacyMcpConfigWarnings());

  return {
    exposedTools,
    requiredPrimaryTools: [...requiredPrimaryMcpTools],
    missingPrimaryTools,
    staleKnowledgeCount: 0,
    staleSourceCount: 0,
    nextActions,
  };
}
