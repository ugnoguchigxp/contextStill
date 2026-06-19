import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetRuntimeSqliteCoreDatabaseForTests } from "../src/db/sqlite/runtime.js";
import {
  recordAuditLog,
  listAuditLogs,
  cleanupExpiredAuditLogs,
} from "../src/modules/audit/audit-log.service.js";
import { recordCompileEval } from "../src/modules/context-compiler/context-compile-eval.service.js";
import {
  getCompileEvalSummaryByRunId,
  listCompileEvalsByRunId,
} from "../src/modules/context-compiler/context-compile-eval.repository.js";
import {
  insertCompileRun,
  listRecentCompileRuns,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  deleteSettingsRow,
  findSettingsRow,
  listSettingsRows,
  upsertSettingsRow,
} from "../src/modules/settings/settings.repository.js";

let tempDir = "";
const originalBackend = process.env.CONTEXT_STILL_DB_BACKEND;
const originalSqlitePath = process.env.CONTEXT_STILL_SQLITE_CORE_PATH;

describe("sqlite runtime support repositories", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "context-still-sqlite-runtime-"));
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH = path.join(tempDir, "context-still-core.sqlite");
    resetRuntimeSqliteCoreDatabaseForTests();
  });

  afterEach(async () => {
    restoreEnv("CONTEXT_STILL_DB_BACKEND", originalBackend);
    restoreEnv("CONTEXT_STILL_SQLITE_CORE_PATH", originalSqlitePath);
    resetRuntimeSqliteCoreDatabaseForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("persists settings rows in sqlite", async () => {
    const saved = await upsertSettingsRow({
      namespace: "runtime",
      key: "sqlite-test",
      value: { enabled: true },
      schemaVersion: 1,
      updatedBy: "sqlite-test",
    });

    expect(saved.value).toEqual({ enabled: true });
    expect(await findSettingsRow("runtime", "sqlite-test")).toMatchObject({
      namespace: "runtime",
      key: "sqlite-test",
      value: { enabled: true },
      updatedBy: "sqlite-test",
    });
    expect((await listSettingsRows("runtime")).map((row) => row.key)).toContain("sqlite-test");

    await deleteSettingsRow("runtime", "sqlite-test");
    expect(await findSettingsRow("runtime", "sqlite-test")).toBeNull();
  });

  test("persists and cleans audit logs in sqlite", async () => {
    await recordAuditLog({
      eventType: "SQLITE_RUNTIME_TEST",
      actor: "system",
      payload: { apiKey: "secret-value", ok: true },
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await recordAuditLog({
      eventType: "SQLITE_RUNTIME_TEST",
      actor: "agent",
      payload: { ok: true },
    });

    const listed = await listAuditLogs({ eventType: "SQLITE_RUNTIME_TEST", limit: 10 });
    expect(listed.total).toBe(2);
    expect(listed.availableEventTypes).toContain("SQLITE_RUNTIME_TEST");
    expect(listed.items.some((item) => item.actor === "agent")).toBe(true);
    expect(JSON.stringify(listed.items)).not.toContain("secret-value");

    const cleanup = await cleanupExpiredAuditLogs({ retentionDays: 7, trigger: "sqlite-test" });
    expect(cleanup.deletedCount).toBe(1);
    const remaining = await listAuditLogs({ eventType: "SQLITE_RUNTIME_TEST", limit: 10 });
    expect(remaining.total).toBe(1);
  });

  test("persists compile evals and resolves latest session run in sqlite", async () => {
    const runId = await insertCompileRun({
      goal: "sqlite compile eval",
      intent: "implementation",
      sessionId: "sqlite-session",
      repoPath: "/repo/contextStill",
      input: { goal: "sqlite compile eval" },
      retrievalMode: "implementation_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 12,
      source: "mcp",
    });

    const explicit = await recordCompileEval({
      input: {
        runId,
        outcome: "useful",
        body: "explicit eval",
        relevance: 90,
        actionability: 80,
        coverage: 70,
        clarity: 60,
        specificity: 50,
      },
      requestMeta: { sessionId: "sqlite-session" },
      source: "mcp",
    });
    expect(explicit.evaluation.runId).toBe(runId);
    expect(explicit.evaluation.avg).toBe(70);

    const resolved = await recordCompileEval({
      input: {
        outcome: "partial",
        body: "resolved eval",
        relevance: 80,
        actionability: 80,
        coverage: 80,
        clarity: 80,
        specificity: 80,
      },
      requestMeta: { sessionId: "sqlite-session" },
      source: "mcp",
    });
    expect(resolved.resolvedFrom).toBe("latest_session_run");
    expect(resolved.evaluation.runId).toBe(runId);

    const summary = await getCompileEvalSummaryByRunId(runId);
    expect(summary.count).toBe(2);
    expect(summary.latestOutcome).toBe("partial");
    expect((await listCompileEvalsByRunId(runId)).map((row) => row.body)).toEqual([
      "resolved eval",
      "explicit eval",
    ]);
    expect((await listRecentCompileRuns(1))[0]?.evalSummary.count).toBe(2);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
