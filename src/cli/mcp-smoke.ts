import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eq } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../db/backend.js";
import { closeDbPool, getDb } from "../db/index.js";
import { getRuntimeSqliteCoreDatabase } from "../db/sqlite/runtime.js";
import { knowledgeItems, sources } from "../db/schema.js";
import { normalizeRepoKey, normalizeRepoPath } from "../modules/context-compiler/query-context.js";
import { upsertKnowledgeFromSource } from "../modules/knowledge/knowledge.repository.js";
import { upsertSourceDocument } from "../modules/sources/source.repository.js";
import { readProjectEnv } from "../project-identity.js";

function resolveRequiredPrimaryTools(): readonly string[] {
  const raw = readProjectEnv("MCP_V2")?.trim().toLowerCase();
  const isV2 = !raw || !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
  if (!isV2) {
    return [
      "initial_instructions",
      "context_compile",
      "search_knowledge",
      "register_candidates",
      "memory_search",
      "memory_fetch",
      "doctor",
    ] as const;
  }
  return [
    "initial_instructions",
    "context_compile",
    "search_knowledge",
    "register_candidates",
    "search_memory",
    "fetch_memory",
    "search_episodes",
    "fetch_episode",
    "doctor",
  ] as const;
}

const disallowedTopLevelSchemaKeys = ["oneOf", "anyOf", "allOf", "enum", "not"] as const;

function extractTextContent(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      item && typeof item === "object" && (item as { type?: string }).type === "text"
        ? ((item as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((item): item is string => typeof item === "string")
    .join("\n");
}

function parseToolJson(result: unknown): Record<string, unknown> {
  const text = extractTextContent(result);
  const candidates = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // Try next candidate block.
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
  }
  throw new Error("Tool result did not contain JSON payload.");
}

function parseResourceJson(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Resource result did not contain JSON payload.");
  }

  const contents = (result as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) {
    throw new Error("Resource result did not contain JSON payload.");
  }

  const text = contents
    .map((item) =>
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "",
    )
    .find((item) => item.trim().startsWith("{"));
  if (!text) {
    throw new Error("Resource result did not contain JSON payload.");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function findInvalidTopLevelSchemaKeys(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return ["type"];
  }

  const schema = inputSchema as Record<string, unknown>;
  const invalidKeys: string[] = disallowedTopLevelSchemaKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(schema, key),
  );
  if (schema.type !== "object") invalidKeys.unshift("type");
  return invalidKeys;
}

async function cleanupSmokeRows(input: {
  sourceId: string | null;
  knowledgeId: string | null;
}): Promise<void> {
  if (!input.sourceId && !input.knowledgeId) return;

  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    if (input.knowledgeId) {
      sqlite.db.query("delete from knowledge_items where id = ?").run(input.knowledgeId);
    }
    if (input.sourceId) {
      sqlite.db.query("delete from sources where id = ?").run(input.sourceId);
    }
    if (process.env.CONTEXT_STILL_SMOKE_CLEANUP_SQLITE === "1") {
      sqlite.db.close();
      await Promise.all([
        rm(sqlite.path, { force: true }),
        rm(`${sqlite.path}-wal`, { force: true }),
        rm(`${sqlite.path}-shm`, { force: true }),
      ]);
    }
    return;
  }

  if (input.knowledgeId) {
    await getDb().delete(knowledgeItems).where(eq(knowledgeItems.id, input.knowledgeId));
  }
  if (input.sourceId) {
    await getDb().delete(sources).where(eq(sources.id, input.sourceId));
  }
}

async function main(): Promise<void> {
  const token = `mcp-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const noHitGoal = `zzabsent${Date.now()}${Math.random().toString(36).slice(2, 12)}`;
  const requiredPrimaryTools = resolveRequiredPrimaryTools();
  const repoPath = normalizeRepoPath(process.cwd()) ?? process.cwd();
  const repoKey = normalizeRepoKey(process.cwd()) ?? repoPath.toLowerCase();
  const sourceUri = `${repoPath}/.mcp-smoke/${token}.md`;
  let sourceId: string | null = null;
  let knowledgeId: string | null = null;

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/index.ts"],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    stderr: "pipe",
  });
  const stderrChunks: string[] = [];
  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
  }

  const client = new Client(
    {
      name: "context-still-smoke",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );

  try {
    sourceId = await upsertSourceDocument({
      sourceKind: "wiki",
      uri: sourceUri,
      title: `MCP Smoke Source ${token}`,
      body: `# MCP Smoke\n${token} source evidence`,
      metadata: {
        repoPath,
        repoKey,
        sourceRootPath: `${repoPath}/.mcp-smoke`,
      },
    });
    knowledgeId = await upsertKnowledgeFromSource({
      sourceUri,
      type: "rule",
      status: "active",
      scope: "repo",
      title: `MCP Smoke Rule ${token}`,
      body: `${token} context compile hit validation`,
      metadata: {
        repoPath,
        repoKey,
        sourceUri,
      },
    });

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    const missingPrimaryTools = requiredPrimaryTools.filter((name) => !toolNames.includes(name));
    if (missingPrimaryTools.length > 0) {
      throw new Error(`Missing primary tools: ${missingPrimaryTools.join(", ")}`);
    }
    const invalidSchemaTools = tools.tools
      .map((tool) => ({
        name: tool.name,
        invalidKeys: findInvalidTopLevelSchemaKeys(tool.inputSchema),
      }))
      .filter((tool) => tool.invalidKeys.length > 0);
    if (invalidSchemaTools.length > 0) {
      throw new Error(
        `Invalid MCP input schemas: ${invalidSchemaTools
          .map((tool) => `${tool.name}(${tool.invalidKeys.join(",")})`)
          .join(", ")}`,
      );
    }

    const initialInstructions = await client.callTool({
      name: "initial_instructions",
      arguments: {},
    });
    const initialText = extractTextContent(initialInstructions);
    if (!initialText.includes("## 常用ルール") && !initialText.includes("## Core Rules")) {
      throw new Error("initial_instructions response is missing expected heading.");
    }

    const noHit = await client.callTool({
      name: "context_compile",
      arguments: {
        goal: noHitGoal,
      },
    });
    const noHitText = extractTextContent(noHit);
    if (noHitText.trim() !== "No Content") {
      throw new Error("context_compile no-hit check failed.");
    }
    const noHitSnapshot = parseResourceJson(
      await client.readResource({ uri: "context-still://packs/latest" }),
    );
    const noHitRun = (noHitSnapshot.run ?? {}) as Record<string, unknown>;
    const noHitReasons = Array.isArray(noHitRun.degradedReasons) ? noHitRun.degradedReasons : [];
    if (noHitRun.goal !== noHitGoal) {
      throw new Error("context_compile no-hit snapshot check failed.");
    }
    if (!noHitReasons.includes("NO_ACTIVE_KNOWLEDGE_MATCH")) {
      throw new Error("context_compile no-hit check failed.");
    }

    const hit = await client.callTool({
      name: "context_compile",
      arguments: {
        goal: token,
      },
    });
    const hitText = extractTextContent(hit);
    if (!hitText.includes(token)) {
      throw new Error("context_compile hit response did not include the smoke token.");
    }
    const hitSnapshot = parseResourceJson(
      await client.readResource({ uri: "context-still://packs/latest" }),
    );
    const hitRun = (hitSnapshot.run ?? {}) as Record<string, unknown>;
    const hitItems = Array.isArray(hitSnapshot.items) ? hitSnapshot.items : [];
    if (hitRun.goal !== token) {
      throw new Error("context_compile hit snapshot check failed.");
    }
    if (hitItems.length === 0) {
      throw new Error("context_compile hit check failed.");
    }

    const doctor = await client.callTool({
      name: "doctor",
      arguments: {},
    });
    const doctorReport = parseToolJson(doctor);
    const doctorMcp = (doctorReport.mcp ?? {}) as Record<string, unknown>;
    const exposedTools = Array.isArray(doctorMcp.exposedTools) ? doctorMcp.exposedTools : [];
    const doctorMissingPrimary = Array.isArray(doctorMcp.missingPrimaryTools)
      ? doctorMcp.missingPrimaryTools
      : [];
    if (exposedTools.length === 0) {
      throw new Error("doctor report does not include MCP exposedTools.");
    }
    if (doctorMissingPrimary.length > 0) {
      throw new Error(
        `doctor report found missing primary tools: ${doctorMissingPrimary.join(", ")}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          checkedTools: toolNames.length,
          requiredPrimaryTools: [...requiredPrimaryTools],
          token,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const stderrOutput = stderrChunks.join("").trim();
    if (stderrOutput) {
      console.error("[mcp-smoke][server-stderr]");
      console.error(stderrOutput);
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await cleanupSmokeRows({ sourceId, knowledgeId });
    await closeDbPool();
  }
}

main().catch((error) => {
  console.error("[mcp-smoke] failed:", error);
  process.exitCode = 1;
});
