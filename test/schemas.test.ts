import { describe, expect, test } from "vitest";
import { compileInputSchema } from "../src/shared/schemas/compile.schema.ts";
import { doctorReportSchema } from "../src/shared/schemas/doctor.schema.ts";
import {
  knowledgeSearchInputSchema,
  registerKnowledgeInputSchema,
} from "../src/shared/schemas/knowledge.schema.ts";
import { recordVibeMemoryInputSchema } from "../src/shared/schemas/vibe-memory.schema.ts";

describe("Shared Schemas", () => {
  test("knowledgeSearchInputSchema parses valid input", () => {
    const input = { query: "test", limit: 10 };
    expect(knowledgeSearchInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("registerKnowledgeInputSchema parses valid input", () => {
    const input = { title: "T", body: "B" };
    expect(registerKnowledgeInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("compileInputSchema parses valid input", () => {
    const input = { goal: "test" };
    expect(compileInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("doctorReportSchema parses valid input", () => {
    const input = {
      status: "ok",
      checkedAt: new Date().toISOString(),
      reasons: [],
      db: { reachable: true, durationMs: 10 },
      vector: { installed: true },
      embedding: {
        configured: true,
        provider: "daemon",
        daemon: { url: "http://llm", reachable: true },
        cli: { python: "python", root: "/root", modelDir: "/models", usable: true },
      },
      agenticLlm: {
        providerSetting: "auto",
        selectedProvider: "local-llm",
        fallbackOrder: ["azure-openai", "bedrock", "local-llm"],
        provider: "local-llm",
        configured: false,
        reachable: false,
        model: "",
        endpoint: "",
      },
      tables: { expected: [], existing: [], missing: [] },
      runs: {
        windowSize: 10,
        totalRuns: 0,
        degradedRuns: 0,
        degradedRate: 0,
        durationMsP50: null,
        durationMsP95: null,
        durationMsAvg: null,
        lastRunAt: null,
        lastRunAgeMinutes: null,
        freshnessThresholdMinutes: 60,
        degradedRateThreshold: 0.1,
      },
      hitl: {
        draftCount: 0,
        oldestDraftAt: null,
        oldestDraftAgeMinutes: null,
        draftFromSourceDistillationCount: 0,
        draftFromVibeDistillationCount: 0,
        backlogThresholdCount: 50,
        backlogThresholdAgeMinutes: 4320,
      },
      knowledgeLifecycle: {
        activeCount: 0,
        zeroUseActiveCount: 0,
        staleByDecayCount: 0,
        staleProcedureCount: 0,
        dynamicScoreAvg: null,
        dynamicScoreP95: null,
        lastCompiledAt: null,
        lastCompiledAgeMinutes: null,
        thresholds: {
          staleDecayFactor: 0.5,
          zeroUseWarningMinActiveCount: 10,
        },
      },
      mcp: {
        exposedTools: [],
        requiredPrimaryTools: [],
        missingPrimaryTools: [],
        staleKnowledgeCount: 0,
        staleSourceCount: 0,
        nextActions: [],
      },
      agentLogSync: {
        codex: {
          sessionDir: "s",
          sessionDirExists: true,
          archivedSessionDir: "a",
          archivedSessionDirExists: true,
        },
        antigravity: { logDir: "l", configured: true, exists: true },
        states: [],
        launchAgent: { label: "l", plistPath: "p", installed: true, loaded: true, state: "s" },
        nextActions: [],
      },
      vibeDistillation: {
        launchAgent: { label: "l", plistPath: "p", installed: true, loaded: true, state: "s" },
        runs: {
          totalRuns: 0,
          okRuns: 0,
          skippedRuns: 0,
          outcomeKindCounts: [],
          skippedRunReasons: [],
          failedRuns: 0,
          lastRunAt: null,
          lastRunAgeMinutes: null,
          lastOkRunAt: null,
          lastOkRunAgeMinutes: null,
        },
        jobs: {
          queued: 0,
          running: 0,
          paused: 0,
          failed: 0,
          lastPausedAt: null,
          lastError: null,
        },
        nextActions: [],
      },
      sourceDistillation: {
        launchAgent: { label: "l", plistPath: "p", installed: true, loaded: true, state: "s" },
        runs: {
          totalRuns: 0,
          okRuns: 0,
          skippedRuns: 0,
          outcomeKindCounts: [],
          skippedRunReasons: [],
          failedRuns: 0,
          lastRunAt: null,
          lastRunAgeMinutes: null,
          lastOkRunAt: null,
          lastOkRunAgeMinutes: null,
        },
        jobs: {
          queued: 0,
          running: 0,
          paused: 0,
          failed: 0,
          lastPausedAt: null,
          lastError: null,
        },
        nextActions: [],
      },
    };
    expect(doctorReportSchema.parse(input)).toEqual(expect.objectContaining({ status: "ok" }));
  });

  test("recordVibeMemoryInputSchema parses valid input", () => {
    const input = {
      sessionId: "s1",
      content: "C",
      memoryType: "chat",
    };
    expect(recordVibeMemoryInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("contextPackSchema parses valid input", async () => {
    const { contextPackSchema } = await import("../src/shared/schemas/context-pack.schema.ts");
    const input = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      intent: "edit",
      retrievalMode: "learning_context",
      status: "ok",
      goal: "Goal",
      minimalTasks: [],
      rules: [],
      procedures: [],
      codeContext: [],
      warnings: [],
      sourceRefs: [],
      diagnostics: {
        degradedReasons: [],
        retrievalStats: {
          textHitCount: 0,
          vectorHitCount: 0,
          mergedCount: 0,
          textFailed: false,
          vectorFailed: false,
          embeddingStatus: "provided",
          queryText: "q",
          scopedSearch: false,
          repoScopeFallbackUsed: false,
        },
      },
    };

    expect(contextPackSchema.parse(input)).toEqual(
      expect.objectContaining({ runId: "550e8400-e29b-41d4-a716-446655440000" }),
    );
  });

  test("recordVibeMemoryInputSchema transforms and refines diffs", () => {
    const input = {
      sessionId: "s1",
      content: "C",
      agentDiffs: [
        { filePath: "a.ts", diff: "some diff" }, // transforms diff to diffHunk
      ],
    };
    const result = recordVibeMemoryInputSchema.parse(input);
    expect(result.agentDiffs[0].diffHunk).toBe("some diff");

    // refine check (must have content)
    expect(() =>
      recordVibeMemoryInputSchema.parse({
        sessionId: "s1",
        content: "C",
        agentDiffs: [{ filePath: "a.ts", diff: " " }],
      }),
    ).toThrow("Agent diff entry requires diffHunk or diff");
  });
});
