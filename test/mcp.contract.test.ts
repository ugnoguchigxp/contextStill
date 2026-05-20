import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { listStaticResources, readStaticResource } from "../src/mcp/server.js";
import { contextCompileTool } from "../src/mcp/tools/context-compile.tool.js";
import { searchKnowledgeTool } from "../src/mcp/tools/knowledge.tool.js";
import { getExposedToolEntries } from "../src/mcp/tools/index.js";
import { initialInstructionsTool } from "../src/mcp/tools/system.tool.js";
import {
  insertCompileRun,
  insertContextPackItems,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("mcp contract", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("context_compile tool input schema contract", () => {
    expect(contextCompileTool.inputSchema).toMatchObject({
      type: "object",
      required: ["goal"],
    });
    const properties = (contextCompileTool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(properties).toBeTruthy();
    expect(properties?.retrievalMode).toEqual({
      type: "string",
      enum: [
        "task_context",
        "review_context",
        "debug_context",
        "architecture_context",
        "procedure_context",
        "learning_context",
      ],
    });
    expect(properties?.errorKind).toEqual({
      type: "string",
      enum: ["typecheck", "lint", "test", "runtime", "build", "unknown"],
    });
    expect(properties?.lastErrorContext).toEqual(
      expect.objectContaining({
        type: "object",
      }),
    );
  });

  test("public tools list contract", () => {
    const toolNames = getExposedToolEntries().map((tool) => tool.name);
    expect(toolNames).toEqual([
      "initial_instructions",
      "context_compile",
      "search_knowledge",
      "register_knowledge",
      "list_knowledge",
      "update_knowledge",
      "read_file",
      "memory_search",
      "memory_fetch",
      "doctor",
    ]);
  });

  test("initial_instructions contains usage-first MCP flow", async () => {
    const response = await initialInstructionsTool.handler();
    const text = response.content[0]?.text ?? "";
    expect(text).toContain("## 常用ルール");
    expect(text).toContain("## MCPツール種別");
    expect(text).toContain("context_compile");
    expect(text).toContain("register_knowledge");
  });

  test("search_knowledge tool input schema contract", () => {
    expect(searchKnowledgeTool.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
    });
    const properties = (searchKnowledgeTool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(properties).toBeTruthy();
    expect(properties?.statuses).toEqual({
      type: "array",
      items: { type: "string", enum: ["draft", "active", "deprecated"] },
    });
  });

  test("resources/list contract", () => {
    const resources = listStaticResources().map((item) => ({
      name: item.name,
      uri: item.uri,
      mimeType: item.mimeType,
    }));
    expect(resources).toEqual([
      {
        name: "context-compiler-summary",
        uri: "memory-router://summary/context-compiler",
        mimeType: "text/plain",
      },
      {
        name: "context-pack-runs-list",
        uri: "memory-router://packs/list",
        mimeType: "application/json",
      },
      {
        name: "context-pack-latest",
        uri: "memory-router://packs/latest",
        mimeType: "application/json",
      },
      {
        name: "doctor-health",
        uri: "memory-router://health/doctor",
        mimeType: "application/json",
      },
    ]);
  });

  test("resources/read returns stable content shapes", async () => {
    const runId = await insertCompileRun({
      goal: "mcp contract run",
      intent: "review",
      input: { goal: "mcp contract run" },
      retrievalMode: "review_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 2048,
      durationMs: 42,
    });
    await insertContextPackItems(runId, [
      {
        itemKind: "rule",
        itemId: "rule-1",
        section: "rules",
        score: 0.7,
        rankingReason: "contract",
        sourceRefs: ["file:///docs/rule.md#line:1-2"],
      },
    ]);

    const summary = (await readStaticResource("memory-router://summary/context-compiler")) as {
      contents: Array<{ text: string }>;
    };
    expect(summary.contents[0]?.text).toContain("retrieval modes");

    const latest = (await readStaticResource("memory-router://packs/latest")) as {
      contents: Array<{ text: string }>;
    };
    const latestJson = JSON.parse(latest.contents[0]?.text ?? "{}") as Record<string, unknown>;
    expect((latestJson.run as { id?: string }).id).toBe(runId);
    expect(Array.isArray(latestJson.items)).toBe(true);

    const doctor = (await readStaticResource("memory-router://health/doctor")) as {
      contents: Array<{ text: string }>;
    };
    const doctorJson = JSON.parse(doctor.contents[0]?.text ?? "{}") as Record<string, unknown>;
    expect(
      doctorJson.status === "ok" ||
        doctorJson.status === "degraded" ||
        doctorJson.status === "failed",
    ).toBe(true);
    expect(Array.isArray(doctorJson.reasons)).toBe(true);
    const mcp = doctorJson.mcp as Record<string, unknown>;
    expect(Array.isArray(mcp?.exposedTools)).toBe(true);
    expect(Array.isArray(mcp?.requiredPrimaryTools)).toBe(true);
    expect(Array.isArray(mcp?.missingPrimaryTools)).toBe(true);
  });

  test("context_compile degraded suggestions use only supported tools/commands", async () => {
    const response = await contextCompileTool.handler({
      goal: "fresh repo no knowledge",
      intent: "debug",
    });
    const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
      diagnostics?: { retrievalStats?: { suggestedNextCalls?: string[] } };
    };
    const suggested = payload.diagnostics?.retrievalStats?.suggestedNextCalls ?? [];
    const allowedExact = new Set([
      "search_knowledge",
      "memory_search",
      "doctor",
      "context_compile (retry with explicit repoPath/files)",
      "bun run import:sources -- <wiki root>",
      "bun run distill:sources -- --apply",
    ]);
    expect(
      suggested.every((entry) => allowedExact.has(entry)),
      `unexpected suggestions: ${suggested.join(", ")}`,
    ).toBe(true);
  });
});
