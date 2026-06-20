import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listCandidateItems } from "../api/modules/candidates/candidates.repository.js";
import {
  fetchOverviewDashboardForApi,
  fetchOverviewDomainForApi,
} from "../api/modules/overview/overview.repository.js";
import {
  fetchActiveTasks,
  fetchQueueDashboardStats,
  listQueueItems,
} from "../api/modules/queue/queue.repository.js";
import { resetRuntimeSqliteCoreDatabaseForTests } from "../src/db/sqlite/runtime.js";
import { getRuntimeSqliteCoreDatabase } from "../src/db/sqlite/runtime.js";
import {
  cleanupExpiredAuditLogs,
  listAuditLogs,
  recordAuditLog,
} from "../src/modules/audit/audit-log.service.js";
import {
  getCompileEvalSummaryByRunId,
  listCompileEvalsByRunId,
} from "../src/modules/context-compiler/context-compile-eval.repository.js";
import { recordCompileEval } from "../src/modules/context-compiler/context-compile-eval.service.js";
import {
  getCompileRunDetail,
  getCompileRunRankingTrace,
  insertCompileRun,
  listRecentCompileRuns,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  getContextDecisionDetail,
  getContextDecisionMetrics,
  insertContextDecisionCoverageRows,
  insertContextDecisionEvidenceRows,
  insertContextDecisionRun,
  saveHumanDecisionFeedback,
} from "../src/modules/context-decision/context-decision.repository.js";
import { inspectDatabase } from "../src/modules/doctor/inspectors/database.inspector.js";
import {
  createEpisode,
  fetchEpisode,
  searchEpisodes,
} from "../src/modules/episodic-memory/episode-card.service.js";
import { recordCompileRunKnowledgeFeedback } from "../src/modules/knowledge/knowledge-feedback.service.js";
import { readVibeMemoryByTokenWindow } from "../src/modules/memoryReader/reader.service.js";
import { retryQueueJob } from "../src/modules/queue/core/state.js";
import { runQueueWorkerOnce } from "../src/modules/queue/core/worker.js";
import {
  deleteSettingsRow,
  findSettingsRow,
  listSettingsRows,
  upsertSettingsRow,
} from "../src/modules/settings/settings.repository.js";
import {
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../src/modules/vibe-memory/vibe-memory.service.js";

let tempDir = "";
const originalBackend = process.env.CONTEXT_STILL_DB_BACKEND;
const originalSqlitePath = process.env.CONTEXT_STILL_SQLITE_CORE_PATH;
const originalDatabaseUrl = process.env.DATABASE_URL;

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
    restoreEnv("DATABASE_URL", originalDatabaseUrl);
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

  test("persists and searches episode cards in sqlite", async () => {
    const episode = await createEpisode({
      title: "SQLite episode recovery",
      situation: "A SQLite migration failed while compiling context.",
      action: "Ran the sqlite runtime support test and fixed schema bootstrap.",
      outcome: "The runtime repository could read the new tables.",
      lesson: "Add SQLite schema changes to core bootstrap before wiring MCP tools.",
      sourceKind: "manual",
      sourceKey: "sqlite-runtime-support-episode",
      outcomeKind: "success",
      evidenceStatus: "verified",
      confidence: 90,
      domains: ["episodic-memory"],
      technologies: ["sqlite", "typescript"],
      changeTypes: ["schema"],
      refs: [{ refKind: "file", refValue: "src/db/sqlite/core-schema.ts" }],
    });

    expect(episode.refs[0]?.refKind).toBe("file");
    expect((await fetchEpisode(episode.id))?.title).toBe("SQLite episode recovery");

    const hits = await searchEpisodes({
      query: "schema bootstrap",
      technologies: ["sqlite"],
      limit: 5,
    });
    expect(hits[0]?.id).toBe(episode.id);
    expect(hits[0]?.score).toBeGreaterThan(0);
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
      retrievalMode: "task_context",
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

  test("persists compile run knowledge feedback and reflects it in sqlite run detail", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    const knowledgeId = "550e8400-e29b-41d4-a716-446655440001";

    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        knowledgeId,
        "rule",
        "active",
        "repo",
        "positive",
        "[]",
        "SQLite feedback rule",
        "Use when SQLite feedback needs to be reflected.",
        "{}",
        80,
        80,
        "{}",
        now,
        now,
      );

    const runId = await insertCompileRun({
      goal: "sqlite feedback detail",
      intent: "implementation",
      input: { goal: "sqlite feedback detail" },
      retrievalMode: "task_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 12,
      source: "ui",
    });

    const pack = {
      runId,
      goal: "sqlite feedback detail",
      retrievalMode: "task_context",
      status: "ok",
      minimalTasks: [],
      rules: [
        {
          id: "rule-1",
          itemKind: "rule",
          itemId: knowledgeId,
          section: "rules",
          title: "SQLite feedback rule",
          content: "Use when SQLite feedback needs to be reflected.",
          score: 0.9,
          rankingReason: "selected",
          sourceRefs: [],
        },
      ],
      procedures: [],
      guardrails: [],
      warnings: [],
      sourceRefs: [],
      diagnostics: {
        degradedReasons: [],
        retrievalStats: {},
      },
    };

    sqlite.db
      .query("update context_compile_runs set pack_snapshot = ? where id = ?")
      .run(JSON.stringify(pack), runId);
    sqlite.db
      .query(
        `
        insert into context_pack_items (
          run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", knowledgeId, "rules", 0.9, "selected", "[]", now);
    sqlite.db
      .query(
        `
        insert into context_compile_candidate_traces (
          run_id, item_kind, item_id, final_rank, final_score, selected, agentic_decision,
          ranking_reason, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", knowledgeId, 1, 0.9, 1, "accepted", "selected", now);

    const result = await recordCompileRunKnowledgeFeedback({
      runId,
      actor: "user",
      items: [{ knowledgeId, verdict: "used" }],
    });
    expect(result.savedCount).toBe(1);

    const detail = await getCompileRunDetail(runId);
    expect(detail?.knowledgeFeedback).toHaveLength(1);
    expect(detail?.knowledgeSignals[0]?.effectiveVerdict).toBe("used");
    expect(detail?.knowledgeSignals[0]?.effectiveActor).toBe("user");

    const trace = await getCompileRunRankingTrace(runId);
    expect(trace?.items[0]?.feedback.verdict).toBe("used");
    expect(trace?.feedbackSummary.used).toBe(1);
    expect(trace?.feedbackSummary.noSignal).toBe(0);
  });

  test("inspects sqlite core database without requiring postgres-only tables", async () => {
    const inspection = await inspectDatabase({
      freshnessThresholdMinutes: 720,
      staleDecayFactor: 0.5,
      zeroUseWarningMinActiveCount: 10,
    });

    expect(inspection.reachable).toBe(true);
    expect(inspection.expectedTables).toContain("knowledge_items");
    expect(inspection.expectedTables).toContain("context_compile_runs");
    expect(inspection.expectedTables).toContain("finding_candidate_queue");
    expect(inspection.expectedTables).toContain("vibe_memories");
    expect(inspection.expectedTables).toContain("context_decision_runs");
    expect(inspection.missingTables).not.toContain("finding_candidate_queue");
    expect(inspection.reasons).not.toContain("SQLITE_PENDING_MIGRATION_DOMAINS");
  });

  test("persists vibe memories and diff entries in sqlite", async () => {
    const recorded = await recordVibeMemoryWithDiffEntries({
      sessionId: "sqlite-vibe-session",
      content: "SQLite ingest memory about queue migration.",
      memoryType: "chat",
      diff: "diff --git a/src/sqlite.ts b/src/sqlite.ts\n+queue migration marker",
      agentDiffs: [
        {
          filePath: "src/sqlite.ts",
          diffHunk: "+sqlite memory marker",
          changeType: "modify",
          language: "typescript",
          symbolName: "sqliteMemory",
        },
      ],
      metadata: { apiKey: "secret-value" },
    });

    expect(recorded.memory.id).toBeTruthy();
    expect(recorded.diffEntries.length).toBeGreaterThan(0);

    const memories = await retrieveVibeMemoryContext({
      query: "queue migration marker",
      sessionId: "sqlite-vibe-session",
      limit: 5,
    });
    expect(memories.map((memory: { id: string }) => memory.id)).toContain(recorded.memory.id);
    expect(JSON.stringify(memories)).not.toContain("secret-value");

    const read = await readVibeMemoryByTokenWindow({
      vibeMemoryId: recorded.memory.id,
      readTokens: 200,
      mode: "original",
    });
    expect(read.content).toContain("SQLite ingest memory");
    expect(read.content).toContain("sqlite memory marker");
  });

  test("persists context decision runs, evidence, and feedback in sqlite", async () => {
    const decisionId = await insertContextDecisionRun({
      input: {
        decisionPoint: "Should SQLite context decision run?",
        sessionId: "sqlite-decision-session",
        retrievalHints: { technologies: ["sqlite"], changeTypes: ["migration"], domains: [] },
        metadata: { branch: "sqlite-test" },
      },
      decision: "execute",
      selectedAction: "implement sqlite branch",
      rejectedActions: ["wait"],
      mandate: "Implement the SQLite branch.",
      agentMessage: "Proceed with SQLite context decision.",
      confidence: 82,
      confidenceTrace: { evidence: 1 },
      guardrails: { commit: false },
      unsupportedAlternatives: [],
      status: "completed",
    });
    await insertContextDecisionEvidenceRows(decisionId, [
      {
        knowledgeId: null,
        role: "selected_support",
        weightAtDecision: 80,
        dynamicScoreAtDecision: null,
        applicabilityScore: 70,
        temporalRelevance: null,
        summary: "SQLite evidence",
        sourceRefs: ["sqlite://evidence"],
        metadata: { ok: true },
      },
    ]);
    await insertContextDecisionCoverageRows(decisionId, [
      {
        query: "sqlite migration",
        queryRole: "support",
        scope: { repo: "contextStill" },
        hitCount: 1,
        maxSimilarity: null,
        selectedKnowledgeIds: [],
        rejectedKnowledgeIds: [],
        reason: "covered",
      },
    ]);
    await saveHumanDecisionFeedback({
      decisionId,
      value: "good",
      affectedKnowledgeIds: [],
    });

    const detail = await getContextDecisionDetail(decisionId);
    expect(detail?.run.decision).toBe("execute");
    expect(detail?.evidence[0]?.summary).toBe("SQLite evidence");
    expect(detail?.coverage[0]?.query).toBe("sqlite migration");
    expect(detail?.run.humanFeedback).toBe("good");

    const metrics = await getContextDecisionMetrics();
    expect(metrics.totalDecisions).toBe(1);
    expect(metrics.goodFeedbackCount).toBe(1);
  });

  test("returns idle queue worker result from empty sqlite queues", async () => {
    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "sqlite-worker",
    });

    expect(result.ok).toBe(true);
    expect(result.idle).toBe(true);
    expect(result.message).toBe("no runnable job");
  });

  test("persists covering retry options in sqlite", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, attempt_count, provider_policy,
          payload, completed_at, locked_by, locked_at, heartbeat_at, last_error,
          created_at, updated_at
        ) values (?, ?, 'failed', 50, 2, 'default', ?, ?, 'worker-old', ?, ?, 'old error', ?, ?)
      `,
      )
      .run(
        "covering-retry",
        "candidate-retry",
        JSON.stringify({ forceRefreshEvidence: false }),
        now,
        now,
        now,
        now,
        now,
      );

    const result = await retryQueueJob({
      queueName: "coveringEvidence",
      id: "covering-retry",
      mode: "cloud_api",
      forceRefreshEvidence: true,
      reason: "manual retry",
    });

    expect(result).toEqual({ id: "covering-retry", status: "pending" });
    const row = sqlite.db
      .query<
        { status: string; attempt_count: number; provider_policy: string; payload: string },
        []
      >(
        `
        select status, attempt_count, provider_policy, payload
        from covering_evidence_queue
        where id = 'covering-retry'
      `,
      )
      .get();
    const payload = JSON.parse(row?.payload ?? "{}");
    expect(row).toMatchObject({
      status: "pending",
      attempt_count: 0,
      provider_policy: "cloud_api",
    });
    expect(payload.forceRefreshEvidence).toBe(true);
    expect(payload.retryMode).toBe("cloud_api");
    expect(payload.retryReason).toBe("manual retry");
    expect(typeof payload.retryRequestedAt).toBe("string");
  });

  test("does not delete legacy duplicate covering rows during sqlite bootstrap", async () => {
    resetRuntimeSqliteCoreDatabaseForTests();
    const sqliteModule = await import("bun:sqlite");
    const legacyDb = new sqliteModule.Database(process.env.CONTEXT_STILL_SQLITE_CORE_PATH, {
      create: true,
    });
    legacyDb.exec(`
      CREATE TABLE covering_evidence_queue (
        id TEXT PRIMARY KEY,
        found_candidate_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE evidence_coverage_results (
        id TEXT PRIMARY KEY,
        found_candidate_id TEXT NOT NULL,
        producer_queue TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'insufficient',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO covering_evidence_queue (id, found_candidate_id, status, priority)
      VALUES ('legacy-cover-1', 'legacy-candidate', 'completed', 10);
      INSERT INTO covering_evidence_queue (id, found_candidate_id, status, priority)
      VALUES ('legacy-cover-2', 'legacy-candidate', 'failed', 20);
      INSERT INTO evidence_coverage_results (id, found_candidate_id, producer_queue, status)
      VALUES ('legacy-evidence-1', 'legacy-candidate', 'coveringEvidence', 'insufficient');
      INSERT INTO evidence_coverage_results (id, found_candidate_id, producer_queue, status)
      VALUES ('legacy-evidence-2', 'legacy-candidate', 'coveringEvidence', 'provider_failed');
    `);
    legacyDb.close();

    const sqlite = await getRuntimeSqliteCoreDatabase();

    const coveringCount = sqlite.db
      .query<{ count: number }, []>(
        "select count(*) as count from covering_evidence_queue where found_candidate_id = 'legacy-candidate'",
      )
      .get();
    const evidenceCount = sqlite.db
      .query<{ count: number }, []>(
        "select count(*) as count from evidence_coverage_results where found_candidate_id = 'legacy-candidate' and producer_queue = 'coveringEvidence'",
      )
      .get();
    expect(coveringCount?.count).toBe(2);
    expect(evidenceCount?.count).toBe(2);
  });

  test("enforces sqlite covering queue and evidence result uniqueness", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, attempt_count, provider_policy
        ) values (?, ?, 'pending', 50, 0, 'default')
      `,
      )
      .run("covering-unique-1", "candidate-unique");

    expect(() => {
      sqlite.db
        .query(
          `
          insert into covering_evidence_queue (
            id, found_candidate_id, status, priority, attempt_count, provider_policy
          ) values (?, ?, 'pending', 50, 0, 'default')
        `,
        )
        .run("covering-unique-2", "candidate-unique");
    }).toThrow();

    sqlite.db
      .query(
        `
        insert into evidence_coverage_results (
          id, found_candidate_id, producer_queue, producer_job_id, distillation_version,
          status, stage
        ) values (?, ?, 'coveringEvidence', ?, 'v1', 'insufficient', 'source_support')
      `,
      )
      .run("evidence-unique-1", "candidate-unique", "covering-unique-1");

    expect(() => {
      sqlite.db
        .query(
          `
          insert into evidence_coverage_results (
            id, found_candidate_id, producer_queue, producer_job_id, distillation_version,
            status, stage
          ) values (?, ?, 'coveringEvidence', ?, 'v1', 'insufficient', 'source_support')
        `,
        )
        .run("evidence-unique-2", "candidate-unique", "covering-unique-1");
    }).toThrow();
  });

  test("processes insufficient covering jobs through sqlite worker persistence", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, distillation_version,
          status, priority, attempt_count, provider_policy, payload, metadata, created_at, updated_at
        ) values (?, 'provided_candidate', 'knowledge_candidate', ?, ?, 'v-test',
          'completed', 80, 1, 'default', '{}', '{}', ?, ?)
      `,
      )
      .run("finding-covering-insufficient", "candidate://short", "candidate://short", now, now);
    sqlite.db
      .query(
        `
        insert into found_candidates (
          id, finding_job_id, candidate_index, type, title, content, origin, metadata,
          created_at, updated_at
        ) values (?, ?, 0, 'rule', ?, ?, '{}', '{}', ?, ?)
      `,
      )
      .run(
        "candidate-covering-insufficient",
        "finding-covering-insufficient",
        "Tiny candidate",
        "Too short",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, distillation_version, status, priority, attempt_count,
          max_attempts, provider_policy, payload, metadata, created_at, updated_at
        ) values (?, ?, 'v-test', 'pending', 70, 0, 2, 'default', '{}', '{}', ?, ?)
      `,
      )
      .run("covering-insufficient", "candidate-covering-insufficient", now, now);

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "sqlite-covering-worker",
    });

    expect(result).toMatchObject({
      ok: true,
      idle: false,
      claimedJobId: "covering-insufficient",
      completedJobId: "covering-insufficient",
    });
    const job = sqlite.db
      .query<{ status: string; attempt_count: number; last_outcome_kind: string }, []>(
        `
        select status, attempt_count, last_outcome_kind
        from covering_evidence_queue
        where id = 'covering-insufficient'
      `,
      )
      .get();
    expect(job).toEqual({
      status: "completed",
      attempt_count: 1,
      last_outcome_kind: "insufficient",
    });

    const evidence = sqlite.db
      .query<{ status: string; stage: string; producer_job_id: string }, []>(
        `
        select status, stage, producer_job_id
        from evidence_coverage_results
        where found_candidate_id = 'candidate-covering-insufficient'
          and producer_queue = 'coveringEvidence'
      `,
      )
      .get();
    expect(evidence).toEqual({
      status: "insufficient",
      stage: "source_support",
      producer_job_id: "covering-insufficient",
    });
  });

  test("serves candidate list from sqlite when postgres is unreachable", async () => {
    process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:1/context_still_dead";
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into distillation_target_states (
          id, target_kind, target_key, source_uri, distillation_version, status, phase,
          priority_group, sort_key, candidate_count, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "target-1",
        "knowledge_candidate",
        "candidate-target-1",
        "agent://candidate/target-1",
        "v1",
        "completed",
        "selected",
        "normal",
        "candidate-target-1",
        1,
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into find_candidate_results (
          id, target_state_id, candidate_index, title, content, origin, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "candidate-result-1",
        "target-1",
        0,
        "SQLite candidate title",
        "SQLite candidate body",
        "{}",
        "selected",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into cover_evidence_results (
          id, status, stage, type, title, body, importance, confidence, reason, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "candidate-result-1",
        "knowledge_ready",
        "covered",
        "rule",
        "Covered title",
        "Covered body",
        80,
        75,
        "covered",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "knowledge-from-candidate-1",
        "rule",
        "draft",
        "repo",
        "positive",
        "[]",
        "Stored candidate knowledge",
        "Stored candidate body",
        "{}",
        75,
        80,
        JSON.stringify({ coverEvidenceResultId: "candidate-result-1" }),
        now,
        now,
      );
    const result = await listCandidateItems({
      page: 1,
      limit: 50,
      targetKind: "all",
      outcome: "all",
      hasKnowledge: "all",
      includeStored: true,
      sortBy: "latestUpdatedAt",
      sortDir: "desc",
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("candidate-result-1");
    expect(result.items[0]?.outcome).toBe("stored");
    expect(result.items[0]?.knowledge?.id).toBe("knowledge-from-candidate-1");
  });

  test("serves queue dashboard reads from sqlite without postgres SQL", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, status, priority,
          attempt_count, created_at, updated_at, locked_by, locked_at, heartbeat_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "finding-running",
        "source_target",
        "wiki_file",
        "SQLite Queue Source",
        "file:///sqlite-queue.md",
        "running",
        90,
        1,
        now,
        now,
        "worker-1",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into found_candidates (
          id, finding_job_id, candidate_index, title, content, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("candidate-1", "finding-running", 0, "SQLite Candidate", "Candidate body", now, now);
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, attempt_count, provider_policy,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("covering-pending", "candidate-1", "pending", 50, 0, "default", now, now);

    const activeTasks = await fetchActiveTasks();
    expect(activeTasks.map((task) => task.id)).toContain("finding-running");
    expect(activeTasks.find((task) => task.id === "finding-running")?.subjectTitle).toBe(
      "SQLite Queue Source",
    );

    const listed = await listQueueItems({
      queue: "findingCandidate",
      status: "running",
      query: "sqlite queue",
      page: 1,
      limit: 20,
    });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.id).toBe("finding-running");

    const stats = await fetchQueueDashboardStats();
    expect(stats.queues.findingCandidate.counters.running).toBe(1);
    expect(stats.queues.coveringEvidence.counters.pending).toBe(1);
  });

  test("serves overview dashboard and domain reads from sqlite without postgres SQL", async () => {
    process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:1/context_still_dead";
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, dynamic_score, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-knowledge-1",
        "rule",
        "active",
        "repo",
        "positive",
        "[]",
        "Overview knowledge",
        "Overview body",
        "{}",
        75,
        80,
        3,
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, dynamic_score, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-knowledge-2",
        "procedure",
        "active",
        "repo",
        "positive",
        "[]",
        "Overview related knowledge",
        "Overview related body",
        "{}",
        70,
        70,
        8,
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_items_vec_fallback (
          knowledge_id, embedding_json, embedding_dimension, content_hash, updated_at
        ) values (?, ?, ?, ?, ?)
      `,
      )
      .run("overview-knowledge-1", "[0.1,0.2]", 2, "overview-vector-hash", now);
    sqlite.db
      .query(
        `
        insert into sources (id, source_kind, uri, title, body, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-source-1",
        "wiki",
        "file:///overview-source.md",
        "Overview source",
        "Overview source body",
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into source_fragments (id, source_id, locator, heading, content, metadata, created_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-fragment-1",
        "overview-source-1",
        "L1-L2",
        "Overview",
        "Overview fragment body",
        "{}",
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_source_links (
          id, knowledge_id, source_fragment_id, link_type, confidence, metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-source-link-1",
        "overview-knowledge-1",
        "overview-fragment-1",
        "derived_from",
        0.9,
        "{}",
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_source_links (
          id, knowledge_id, source_fragment_id, link_type, confidence, metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-source-link-2",
        "overview-knowledge-2",
        "overview-fragment-1",
        "derived_from",
        0.9,
        "{}",
        now,
      );
    sqlite.db
      .query(
        `
        insert into vibe_memories (id, session_id, content, memory_type, metadata, created_at)
        values (?, ?, ?, ?, ?, ?)
      `,
      )
      .run("overview-vibe-1", "overview-session", "Overview vibe memory", "chat", "{}", now);
    sqlite.db
      .query(
        `
        insert into agent_diff_entries (
          id, vibe_memory_id, file_path, diff_hunk, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("overview-diff-1", "overview-vibe-1", "src/overview.ts", "+overview", "{}", now, now);
    const runId = await insertCompileRun({
      goal: "sqlite overview compile run",
      intent: "implementation",
      input: { goal: "sqlite overview compile run" },
      retrievalMode: "implementation_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 12,
      source: "mcp",
    });
    sqlite.db
      .query(
        `
        insert into context_pack_items (
          run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", "overview-knowledge-1", "knowledge", 0.9, "selected", "[]", now);
    sqlite.db
      .query(
        `
        insert into context_compile_candidate_traces (
          run_id, item_kind, item_id, selected, created_at
        ) values (?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", "overview-knowledge-1", 1, now);
    const replayRunId = await insertCompileRun({
      goal: "sqlite overview related compile run",
      intent: "implementation",
      input: { goal: "sqlite overview related compile run" },
      retrievalMode: "implementation_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 14,
      source: "mcp",
    });
    sqlite.db
      .query(
        `
        insert into context_pack_items (
          run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        replayRunId,
        "procedure",
        "overview-knowledge-2",
        "knowledge",
        0.8,
        "selected",
        "[]",
        now,
      );
    sqlite.db
      .query(
        `
        insert into context_compile_evals (
          id, run_id, score, outcome, body, relevance, actionability, coverage, clarity,
          specificity, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("overview-eval-1", runId, 80, "useful", "overview eval", 80, 82, 78, 81, 79, now, now);
    sqlite.db
      .query(
        `
        insert into context_decision_runs (
          id, decision_point, options, retrieval_hints, decision, rejected_actions,
          mandate, agent_message, confidence, confidence_trace, guardrails,
          unsupported_alternatives, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-decision-1",
        "Use SQLite overview?",
        "[]",
        "{}",
        "execute",
        "[]",
        "Use SQLite overview.",
        "Proceed.",
        90,
        "{}",
        "{}",
        "[]",
        "completed",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into context_decision_human_feedback (id, decision_run_id, value, created_at)
        values (?, ?, ?, ?)
      `,
      )
      .run("overview-human-feedback-1", "overview-decision-1", "good", now);
    sqlite.db
      .query(
        `
        insert into llm_usage_logs (
          id, provider, model, prompt_tokens, completion_tokens, total_tokens,
          reasoning_tokens, cost_jpy, usage_mode, source, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-llm-local-1",
        "local-llm",
        "local-model",
        10,
        20,
        30,
        1,
        0,
        "measured",
        "context_compile",
        now,
      );
    sqlite.db
      .query(
        `
        insert into llm_usage_logs (
          id, provider, model, prompt_tokens, completion_tokens, total_tokens,
          reasoning_tokens, cost_jpy, usage_mode, source, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-llm-cloud-1",
        "azure-openai",
        "gpt-test",
        12,
        18,
        30,
        2,
        0.12,
        "estimated",
        "context_compile",
        now,
      );
    sqlite.db
      .query(
        `
        insert into landscape_snapshots (
          id, snapshot_type, status, params_hash, params, payload, generated_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-landscape-snapshot-1",
        "landscape_snapshot",
        "ready",
        "overview-landscape",
        "{}",
        JSON.stringify({
          stats: {
            totalCommunities: 2,
            strongAttractorCount: 1,
            usefulAttractorCount: 1,
            negativeCandidateCount: 0,
            overSelectedNotUsedCount: 0,
            deadZoneReachabilityCount: 1,
            deadZoneStaleCount: 0,
            insufficientFeedbackCommunities: 1,
          },
          risks: [{ id: "risk-1" }],
        }),
        now,
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into landscape_snapshots (
          id, snapshot_type, status, params_hash, params, payload, generated_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-landscape-replay-1",
        "landscape_replay_comparison",
        "ready",
        "overview-replay",
        "{}",
        JSON.stringify({
          generatedAt: now,
          comparedRunCount: 3,
          averageOverlapRate: 0.75,
          retainedItemCount: 4,
          missingFromCurrentItemCount: 1,
          newlyRetrievedItemCount: 2,
          usedBaselineLostItemCount: 1,
          currentNoMatchRunCount: 0,
          scoreTuning: { highChurnRunCount: 1 },
          promotionGateSummary: { gateMode: "review_required" },
        }),
        now,
        now,
        now,
      );

    const dashboard = await fetchOverviewDashboardForApi();
    expect(dashboard.kpis.knowledgeTotal).toBe(2);
    expect(dashboard.kpis.compileRuns).toBe(2);
    expect(dashboard.kpis.sourceLinks).toBe(2);
    expect(dashboard.kpis.vibeRecords).toBe(1);
    expect(dashboard.kpis.graphEdges).toBeGreaterThan(0);
    expect(dashboard.kpis.graphEmbedded).toBe(1);
    expect(dashboard.kpis.sourceCommunities).toBe(1);
    expect(dashboard.kpis.sourceCoveredCommunities).toBe(1);
    expect(dashboard.llmUsage.kpis.totalCalls30d).toBe(2);
    expect(dashboard.llmUsage.kpis.localTokensTotal30d).toBe(30);
    expect(dashboard.llmUsage.kpis.cloudTokensTotal30d).toBe(30);
    expect(dashboard.compileEvalStats.evaluationCount).toBe(1);
    expect(dashboard.productValueStats.evidence.reusedCompileRunCount).toBe(2);
    expect(dashboard.landscape.status).toBe("ok");

    const knowledge = await fetchOverviewDomainForApi("knowledge-assets");
    const landscape = await fetchOverviewDomainForApi("landscape-health");
    const system = await fetchOverviewDomainForApi("system-quality");
    const llm = await fetchOverviewDomainForApi("llm-resources");

    expect(knowledge.checkedAt).toBeTruthy();
    expect(landscape.checkedAt).toBeTruthy();
    expect(system.checkedAt).toBeTruthy();
    expect(llm.checkedAt).toBeTruthy();
    expect((knowledge as { kpis: { knowledgeTotal: number } }).kpis.knowledgeTotal).toBe(2);
    expect((knowledge as { kpis: { graphEdges: number } }).kpis.graphEdges).toBeGreaterThan(0);
    expect((knowledge as { kpis: { graphEmbedded: number } }).kpis.graphEmbedded).toBe(1);
    expect((system as { kpis: { compileRuns: number } }).kpis.compileRuns).toBe(2);
    expect(
      (system as { compileEvalStats: { evaluationCount: number } }).compileEvalStats
        .evaluationCount,
    ).toBe(1);
    expect(
      (llm as { llmUsage: { kpis: { totalCalls30d: number } } }).llmUsage.kpis.totalCalls30d,
    ).toBe(2);
    expect((landscape as { landscape: { status: string } }).landscape.status).toBe("ok");

    sqlite.db.query("delete from landscape_snapshots").run();
    const fallbackLandscape = (await fetchOverviewDomainForApi("landscape-health")) as {
      landscape: {
        status: string;
        snapshot?: { totalCommunities: number };
        replay?: { comparedRunCount: number };
      };
    };
    expect(fallbackLandscape.landscape.status).toBe("ok");
    expect(fallbackLandscape.landscape.snapshot?.totalCommunities).toBeGreaterThan(0);
    expect(fallbackLandscape.landscape.replay?.comparedRunCount).toBeGreaterThan(0);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
