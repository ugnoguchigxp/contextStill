import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DistillationQueueName } from "../src/modules/queue/core/types.js";

const mocks = vi.hoisted(() => ({
  backendKind: "postgres" as "postgres" | "sqlite",
  execute: vi.fn(),
  sqliteAll: vi.fn(),
  sqliteGet: vi.fn(),
  pauseQueueJob: vi.fn(),
  resumeQueueJob: vi.fn(),
  retryQueueJob: vi.fn(),
  appendQueueEvent: vi.fn(),
  pauseRunningQueueJobs: vi.fn(),
  setQueuePaused: vi.fn(),
  getQueueControlStates: vi.fn(),
  ensureRuntimeSettingsLoaded: vi.fn(),
  getRuntimeSettingsSnapshot: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    execute: (...args: unknown[]) => mocks.execute(...args),
  },
}));

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({ kind: mocks.backendKind }),
}));

vi.mock("../src/db/sqlite/runtime.js", () => ({
  getRuntimeSqliteCoreDatabase: () =>
    Promise.resolve({
      db: {
        query: (sql: string) => ({
          all: (...args: unknown[]) => mocks.sqliteAll(sql, ...args),
          get: (...args: unknown[]) => mocks.sqliteGet(sql, ...args),
        }),
      },
    }),
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: (...args: unknown[]) => mocks.ensureRuntimeSettingsLoaded(...args),
  getRuntimeSettingsSnapshot: (...args: unknown[]) => mocks.getRuntimeSettingsSnapshot(...args),
}));

vi.mock("../src/modules/queue/core/index.js", () => ({
  appendQueueEvent: (...args: unknown[]) => mocks.appendQueueEvent(...args),
  pauseQueueJob: (...args: unknown[]) => mocks.pauseQueueJob(...args),
  resumeQueueJob: (...args: unknown[]) => mocks.resumeQueueJob(...args),
  retryQueueJob: (...args: unknown[]) => mocks.retryQueueJob(...args),
  getQueueControlStates: (...args: unknown[]) => mocks.getQueueControlStates(...args),
  pauseRunningQueueJobs: (...args: unknown[]) => mocks.pauseRunningQueueJobs(...args),
  setQueuePaused: (...args: unknown[]) => mocks.setQueuePaused(...args),
}));

import {
  fetchActiveTasks,
  fetchQueueDashboardStats,
  listQueueItems,
  pauseQueueLane,
  pauseTarget,
  resumeQueueLane,
  resumeTarget,
  retryTarget,
} from "../api/modules/queue/queue.repository.js";

const QUEUE_NAMES = [
  "findingCandidate",
  "episodeDistiller",
  "coveringEvidence",
  "deadZoneMergeReview",
  "landscapeCuration",
  "finalizeDistille",
  "mergeActivationFinalize",
] as const satisfies readonly DistillationQueueName[];

const openaiRoute = {
  provider: "openai" as const,
  model: "gpt-4o",
  fallback: [] as string[],
};

function settingsSnapshot() {
  return {
    providerPools: [
      {
        id: "pool-1",
        label: "Main pool",
        enabled: true,
        maxConcurrent: 1,
        staleLeaseSeconds: 60,
        lowPriorityAgingSeconds: 60,
        targets: [
          { provider: "local-llm" as const, localLlmModelId: "local-a" },
          { provider: "openai" as const, targetId: "openai" },
          { provider: "azure-openai" as const, deploymentSlot: 1 },
          { provider: "bedrock" as const, targetId: "bedrock" },
          { provider: "codex" as const, targetId: "codex" },
          { provider: "larm-agent-connection" as const, connectionId: "conn-1" },
        ],
      },
      {
        id: "empty-pool",
        label: "   ",
        enabled: true,
        maxConcurrent: 1,
        staleLeaseSeconds: 60,
        lowPriorityAgingSeconds: 60,
        targets: [],
      },
    ],
    providers: {
      openai: { model: "gpt-4o" },
      bedrock: { model: "claude-haiku" },
      codex: { model: "codex-mini" },
      "azure-openai": { model: "gpt-4o-azure", deployments: [{ model: "azure-gpt" }] },
      "local-llm": {
        models: [{ id: "local-a", name: "Local A", model: "local-a-model" }],
      },
      "larm-agent-connection": {
        connections: [{ id: "conn-1", agentProfile: "profile-1" }],
      },
    },
    taskRouting: {
      findCandidate: { source: openaiRoute, vibe: openaiRoute },
      webSourceResearch: openaiRoute,
      episodeDistiller: openaiRoute,
      coverEvidence: {
        sourceSupport: openaiRoute,
        externalEvidence: openaiRoute,
        mcpEvidence: openaiRoute,
      },
      deadZoneMergeReview: openaiRoute,
      landscapeCuration: openaiRoute,
      finalizeDistille: openaiRoute,
      mergeActivationFinalize: openaiRoute,
    },
  };
}

function emptyControlStates(overrides: Record<string, unknown> = {}) {
  return {
    findingCandidate: { paused: false, updatedAt: null, updatedBy: null, reason: null },
    episodeDistiller: { paused: false, updatedAt: null, updatedBy: null, reason: null },
    coveringEvidence: { paused: false, updatedAt: null, updatedBy: null, reason: null },
    deadZoneMergeReview: { paused: false, updatedAt: null, updatedBy: null, reason: null },
    landscapeCuration: { paused: false, updatedAt: null, updatedBy: null, reason: null },
    finalizeDistille: { paused: false, updatedAt: null, updatedBy: null, reason: null },
    mergeActivationFinalize: { paused: false, updatedAt: null, updatedBy: null, reason: null },
    ...overrides,
  };
}

function queryText(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => queryText(item, depth + 1)).join(" ");
  if (!value || typeof value !== "object") return "";
  return Object.values(value as Record<string, unknown>)
    .map((item) => queryText(item, depth + 1))
    .join(" ");
}

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status: "pending",
    priority: 40,
    attempt_count: 2,
    subject_title: "Subject",
    subject_detail: "Detail",
    provider: "openai",
    model: "gpt-4o",
    last_error: null,
    last_outcome_kind: null,
    locked_by: "worker-1",
    locked_at: "2026-05-20T00:00:00.000Z",
    heartbeat_at: "unix-ms:1747699200000",
    created_at: "2026-05-20 00:00:00",
    updated_at: "2026-05-20T01:00:00.000Z",
    completed_at: null,
    next_run_at: new Date("2026-05-21T00:00:00.000Z"),
    metadata_summary: "meta",
    source_kind: "wiki_file",
    provider_policy: null,
    ...overrides,
  };
}

function stubPostgres(rows: unknown[], count = rows.length, leases: unknown[] = []) {
  mocks.execute.mockImplementation(async (query: unknown) => {
    const text = queryText(query);
    if (text.includes("llm_provider_leases")) return { rows: leases };
    if (/count\s*\(\s*\*\s*\)/i.test(text)) return { rows: [{ count }] };
    return { rows };
  });
}

function stubSqlite(rows: unknown[], count = rows.length, leases: unknown[] = []) {
  mocks.sqliteAll.mockImplementation((sql: string) => {
    if (sql.includes("llm_provider_leases")) return leases;
    return rows;
  });
  mocks.sqliteGet.mockImplementation((sql: string) => {
    if (/count\s*\(\s*\*\s*\)/i.test(sql)) return { count };
    return { count: 0 };
  });
}

describe("queue repository list and control actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backendKind = "postgres";
    mocks.ensureRuntimeSettingsLoaded.mockResolvedValue(undefined);
    mocks.getRuntimeSettingsSnapshot.mockReturnValue(settingsSnapshot());
    mocks.appendQueueEvent.mockResolvedValue(undefined);
    mocks.pauseRunningQueueJobs.mockResolvedValue(0);
    mocks.getQueueControlStates.mockResolvedValue(emptyControlStates());
    mocks.setQueuePaused.mockImplementation(
      async (params: { queueName: string; paused: boolean; reason?: string }) =>
        emptyControlStates({
          [params.queueName]: {
            paused: params.paused,
            updatedAt: "2026-05-20T00:00:00.000Z",
            updatedBy: "queue-dashboard",
            reason: params.reason ?? null,
          },
        }),
    );
  });

  describe("listQueueItems (postgres)", () => {
    test("defaults queue, clamps pagination, and maps empty results", async () => {
      stubPostgres([], 0);

      const result = await listQueueItems({ page: 0, limit: 0 });

      expect(result).toEqual({
        queue: "findingCandidate",
        items: [],
        total: 0,
        page: 1,
        limit: 1,
      });
      expect(mocks.ensureRuntimeSettingsLoaded).toHaveBeenCalled();
      expect(mocks.execute).toHaveBeenCalled();
    });

    test.each(QUEUE_NAMES)("lists %s with query, status, sort, and pagination", async (queue) => {
      const row = queueRow({
        id: `${queue}-1`,
        queue_name: queue,
        visible_queue_name: queue === "mergeActivationFinalize" ? "finalizeDistille" : queue,
        job_type: queue === "mergeActivationFinalize" ? "merge_activation_finalize" : undefined,
        last_error:
          queue === "findingCandidate" ? "distillation tool loop exceeded max rounds (4)" : "boom",
        source_kind: queue === "findingCandidate" ? "vibe_memory" : "wiki_file",
        provider_policy: queue === "coveringEvidence" ? "cloud_api" : null,
        model: queue === "findingCandidate" ? null : "gpt-4o",
      });
      stubPostgres([row], 12);

      const result = await listQueueItems({
        page: 2,
        limit: 200,
        queue,
        query: "  Subject  ",
        status: "pending",
        sortBy: "subjectTitle",
        sortDir: "asc",
      });

      expect(result.queue).toBe(queue);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(100);
      expect(result.total).toBe(12);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe(`${queue}-1`);
      expect(result.items[0]?.subjectTitle).toBe("Subject");
      expect(result.items[0]?.createdAt).toBe("2026-05-20T00:00:00.000Z");
      if (queue === "findingCandidate") {
        expect(result.items[0]?.lastError).toContain("exhausted 4/4");
      }
      if (queue === "mergeActivationFinalize") {
        expect(result.items[0]?.visibleQueueName).toBe("finalizeDistille");
        expect(result.items[0]?.jobType).toBe("merge_activation_finalize");
      }
    });

    test("attaches active leases and resolves pool target models", async () => {
      stubPostgres([queueRow({ id: "leased-1", model: null })], 1, [
        {
          pool_id: "pool-1",
          target_id: "local-a",
          queue_name: "findingCandidate",
          queue_job_id: "leased-1",
          worker_id: "lease-worker",
        },
      ]);

      const result = await listQueueItems({
        page: 1,
        limit: 10,
        queue: "findingCandidate",
        status: "all",
        sortBy: "priority",
        sortDir: "desc",
      });

      expect(result.items[0]?.activeProviderPoolId).toBe("pool-1");
      expect(result.items[0]?.activeProviderTargetId).toBe("local-a");
      expect(result.items[0]?.lockedBy).toBe("lease-worker");
      expect(result.items[0]?.provider).toBe("local-llm");
      expect(result.items[0]?.model).toBe("local-a-model");
    });

    test("maps unusual timestamps and unknown lease targets", async () => {
      stubPostgres(
        [
          queueRow({
            id: "odd-1",
            created_at: new Date("invalid"),
            updated_at: "not-a-date",
            locked_at: Number.NaN,
            heartbeat_at: "unix-ms:nope",
            completed_at: "   ",
            next_run_at: null,
            model: null,
            provider: null,
            subject_title: null,
            subject_detail: null,
            priority: null,
            attempt_count: null,
          }),
        ],
        1,
        [
          {
            pool_id: "missing-pool",
            target_id: "mystery",
            queue_name: "episodeDistiller",
            queue_job_id: "odd-1",
            worker_id: "w",
          },
        ],
      );

      const result = await listQueueItems({
        page: 1,
        limit: 10,
        queue: "episodeDistiller",
        sortBy: "not-a-field",
      });

      expect(result.items[0]?.subjectTitle).toBe("-");
      expect(result.items[0]?.subjectDetail).toBe("-");
      expect(result.items[0]?.createdAt).toBe(new Date(0).toISOString());
      expect(result.items[0]?.provider).toBeNull();
      expect(result.items[0]?.model).toBe("mystery");
    });

    test("maps azure, numeric, and fallback lease targets", async () => {
      stubPostgres(
        [
          queueRow({ id: "azure-1", model: null }),
          queueRow({ id: "slot-only", model: null }),
          queueRow({ id: "bedrock-1", model: null }),
          queueRow({ id: "codex-1", model: null }),
          queueRow({ id: "larm-1", model: null }),
        ],
        5,
        [
          {
            pool_id: "pool-1",
            target_id: "1",
            queue_name: "findingCandidate",
            queue_job_id: "azure-1",
            worker_id: "w-azure",
          },
          {
            pool_id: "",
            target_id: "2",
            queue_name: "findingCandidate",
            queue_job_id: "slot-only",
            worker_id: "w-slot",
          },
          {
            pool_id: "pool-1",
            target_id: "bedrock",
            queue_name: "findingCandidate",
            queue_job_id: "bedrock-1",
            worker_id: "w-bedrock",
          },
          {
            pool_id: "",
            target_id: "codex",
            queue_name: "findingCandidate",
            queue_job_id: "codex-1",
            worker_id: "w-codex",
          },
          {
            pool_id: "pool-1",
            target_id: "conn-1",
            queue_name: "findingCandidate",
            queue_job_id: "larm-1",
            worker_id: "w-larm",
          },
        ],
      );

      const result = await listQueueItems({ page: 1, limit: 10, queue: "findingCandidate" });
      const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));
      expect(byId["azure-1"]?.provider).toBe("azure-openai");
      expect(byId["azure-1"]?.model).toBe("azure-gpt");
      expect(byId["slot-only"]?.provider).toBe("azure-openai");
      expect(byId["bedrock-1"]?.provider).toBe("bedrock");
      expect(byId["codex-1"]?.provider).toBe("codex");
      expect(byId["larm-1"]?.provider).toBe("larm-agent-connection");
      expect(byId["larm-1"]?.model).toBe("profile-1");
    });

    test("reports sqlite dashboard stats including covering non-registered counts", async () => {
      mocks.backendKind = "sqlite";
      mocks.sqliteAll.mockImplementation((sql: string) => {
        if (sql.includes("llm_provider_leases")) return [];
        if (sql.includes("covering_evidence_queue") || sql.includes("from covering")) {
          return [
            {
              status: "pending",
              count: 2,
              oldest_pending_at: "2026-05-20T00:00:00.000Z",
              offline_count: 1,
              non_registered_count: 4,
            },
          ];
        }
        return [
          {
            status: "failed",
            count: 1,
            oldest_pending_at: null,
            offline_count: 1,
            non_registered_count: 9,
          },
        ];
      });

      const stats = await fetchQueueDashboardStats();
      expect(stats.queues.coveringEvidence.nonRegistered).toBe(4);
      expect(stats.queues.findingCandidate.nonRegistered).toBe(0);
      expect(stats.totals.offline).toBeGreaterThan(0);
      expect(stats.totals.oldestPendingAt).toBe("2026-05-20T00:00:00.000Z");
    });

    test("uses default sort and status=all for covering evidence", async () => {
      stubPostgres([queueRow({ id: "cover-1", model: null, provider_policy: "default" })], 1);

      const result = await listQueueItems({
        page: 1,
        limit: 5,
        queue: "coveringEvidence",
        status: "all",
        sortBy: "status",
        sortDir: "desc",
      });

      expect(result.items[0]?.provider).toBe("openai");
      expect(result.items[0]?.model).toBe("gpt-4o");
    });
  });

  describe("listQueueItems (sqlite)", () => {
    beforeEach(() => {
      mocks.backendKind = "sqlite";
    });

    test("returns empty items when sqlite has no rows", async () => {
      stubSqlite([], 0);

      const result = await listQueueItems({
        page: 3,
        limit: 10,
        queue: "findingCandidate",
        query: "missing",
        status: "failed",
      });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(mocks.sqliteAll).toHaveBeenCalled();
      expect(mocks.sqliteGet).toHaveBeenCalled();
    });

    test.each(QUEUE_NAMES)("lists sqlite %s with sort and query", async (queue) => {
      stubSqlite(
        [
          queueRow({
            id: `sqlite-${queue}`,
            queue_name: queue,
            model: null,
            last_error: "distillation tool loop exceeded max rounds (0)",
          }),
        ],
        4,
      );

      const result = await listQueueItems({
        page: 1,
        limit: 10,
        queue,
        query: "sqlite",
        status: "running",
        sortBy: "subjectTitle",
        sortDir: "asc",
      });

      expect(result.items[0]?.id).toBe(`sqlite-${queue}`);
      expect(result.total).toBe(4);
      if (queue === "findingCandidate") {
        expect(result.items[0]?.lastError).toContain("reader tool calls were exhausted");
      }
    });

    test("count treats a missing sqlite count row as zero", async () => {
      mocks.sqliteAll.mockReturnValue([queueRow({ id: "row-1" })]);
      mocks.sqliteGet.mockReturnValue(null);

      const result = await listQueueItems({
        page: 1,
        limit: 10,
        queue: "deadZoneMergeReview",
        sortBy: "updatedAt",
      });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(0);
    });
  });

  describe("fetchActiveTasks", () => {
    test("returns an empty list when no queues have running jobs", async () => {
      stubPostgres([], 0);

      await expect(fetchActiveTasks()).resolves.toEqual([]);
    });

    test("merges running jobs and sorts by updatedAt descending", async () => {
      mocks.execute.mockImplementation(async () => ({
        rows: [
          queueRow({
            id: "old",
            status: "running",
            updated_at: "2026-05-20T00:00:00.000Z",
          }),
          queueRow({
            id: "new",
            status: "running",
            updated_at: "2026-05-21T00:00:00.000Z",
          }),
        ],
      }));

      const tasks = await fetchActiveTasks();

      expect(tasks.length).toBeGreaterThan(0);
      const newest = tasks[0]?.updatedAt ?? "";
      const oldest = tasks[tasks.length - 1]?.updatedAt ?? "";
      expect(newest >= oldest).toBe(true);
      expect(tasks.some((task) => task.status === "running")).toBe(true);
    });

    test("loads sqlite running jobs and attaches leases", async () => {
      mocks.backendKind = "sqlite";
      mocks.sqliteAll.mockImplementation((sql: string) => {
        if (sql.includes("llm_provider_leases")) {
          return [
            {
              pool_id: "pool-1",
              target_id: "openai",
              queue_name: "findingCandidate",
              queue_job_id: "run-1",
              worker_id: "lease-w",
            },
          ];
        }
        return [
          queueRow({
            id: "run-1",
            status: "running",
            queue_name: "findingCandidate",
            model: null,
          }),
        ];
      });

      const tasks = await fetchActiveTasks();
      const leased = tasks.find(
        (task) => task.id === "run-1" && task.queueName === "findingCandidate",
      );
      expect(leased?.activeProviderPoolId).toBe("pool-1");
      expect(leased?.provider).toBe("openai");
    });
  });

  describe("target and lane controls", () => {
    test("pauseTarget appends an event on success and returns null when missing", async () => {
      mocks.pauseQueueJob.mockResolvedValueOnce({ id: "job-1", status: "paused" });
      await expect(pauseTarget("findingCandidate", "job-1", "hold")).resolves.toEqual({
        id: "job-1",
        status: "paused",
      });
      expect(mocks.appendQueueEvent).toHaveBeenCalledWith({
        queueName: "findingCandidate",
        queueJobId: "job-1",
        eventType: "paused",
        message: "hold",
      });

      mocks.pauseQueueJob.mockResolvedValueOnce(null);
      await expect(pauseTarget("findingCandidate", "missing", "hold")).resolves.toBeNull();
      expect(mocks.appendQueueEvent).toHaveBeenCalledTimes(1);
    });

    test("resumeTarget appends an event on success and returns null when missing", async () => {
      mocks.resumeQueueJob.mockResolvedValueOnce({ id: "job-1", status: "pending" });
      await expect(resumeTarget("coveringEvidence", "job-1")).resolves.toEqual({
        id: "job-1",
        status: "pending",
      });
      expect(mocks.appendQueueEvent).toHaveBeenCalledWith({
        queueName: "coveringEvidence",
        queueJobId: "job-1",
        eventType: "resumed",
        message: "resumed from queue control",
      });

      mocks.resumeQueueJob.mockResolvedValueOnce(null);
      await expect(resumeTarget("coveringEvidence", "missing")).resolves.toBeNull();
    });

    test("retryTarget records mode metadata and returns null when missing", async () => {
      mocks.retryQueueJob.mockResolvedValueOnce({ id: "job-1", status: "pending" });
      await expect(
        retryTarget({
          queueName: "episodeDistiller",
          id: "job-1",
          mode: "cloud_api",
          forceRefreshEvidence: true,
          reason: "again",
        }),
      ).resolves.toEqual({ id: "job-1", status: "pending" });
      expect(mocks.appendQueueEvent).toHaveBeenCalledWith({
        queueName: "episodeDistiller",
        queueJobId: "job-1",
        eventType: "retried",
        message: "again",
        metadata: { mode: "cloud_api", forceRefreshEvidence: true },
      });

      mocks.retryQueueJob.mockResolvedValueOnce(null);
      await expect(
        retryTarget({
          queueName: "episodeDistiller",
          id: "missing",
          mode: "default",
          forceRefreshEvidence: false,
        }),
      ).resolves.toBeNull();
    });

    test("pauseQueueLane pauses a single lane", async () => {
      mocks.pauseRunningQueueJobs.mockResolvedValue(3);

      const result = await pauseQueueLane("findingCandidate", "maintenance");

      expect(mocks.setQueuePaused).toHaveBeenCalledTimes(1);
      expect(mocks.pauseRunningQueueJobs).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        queueName: "findingCandidate",
        state: {
          paused: true,
          updatedAt: "2026-05-20T00:00:00.000Z",
          updatedBy: "queue-dashboard",
          reason: "maintenance",
        },
        pausedRunningCount: 3,
      });
    });

    test("pauseQueueLane also pauses mergeActivationFinalize for finalizeDistille", async () => {
      mocks.pauseRunningQueueJobs.mockResolvedValueOnce(2).mockResolvedValueOnce(5);

      const result = await pauseQueueLane("finalizeDistille");

      expect(mocks.setQueuePaused).toHaveBeenCalledTimes(2);
      expect(mocks.setQueuePaused).toHaveBeenNthCalledWith(2, {
        queueName: "mergeActivationFinalize",
        paused: true,
        reason: undefined,
        updatedBy: "queue-dashboard",
      });
      expect(result.pausedRunningCount).toBe(7);
    });

    test("resumeQueueLane resumes a single lane", async () => {
      const result = await resumeQueueLane("coveringEvidence", "go");

      expect(mocks.setQueuePaused).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        queueName: "coveringEvidence",
        state: {
          paused: false,
          updatedAt: "2026-05-20T00:00:00.000Z",
          updatedBy: "queue-dashboard",
          reason: "go",
        },
        reason: "go",
      });
    });

    test("resumeQueueLane also resumes mergeActivationFinalize for finalizeDistille", async () => {
      const result = await resumeQueueLane("finalizeDistille");

      expect(mocks.setQueuePaused).toHaveBeenCalledTimes(2);
      expect(mocks.setQueuePaused).toHaveBeenNthCalledWith(2, {
        queueName: "mergeActivationFinalize",
        paused: false,
        reason: undefined,
        updatedBy: "queue-dashboard",
      });
      expect(result.reason).toBeNull();
    });
  });
});
