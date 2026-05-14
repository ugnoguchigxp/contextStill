import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { listStaticResources, readStaticResource } from "../src/mcp/server.js";
import { contextCompileTool } from "../src/mcp/tools/context-compile.tool.js";
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
  });
});
