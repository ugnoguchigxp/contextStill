import { describe, expect, test } from "vitest";
import { compileInputSchema } from "../src/shared/schemas/compile.schema.ts";
import { doctorReportSchema } from "../src/shared/schemas/doctor.schema.ts";
import {
  knowledgeSearchInputSchema,
  registerCandidateInputSchema,
  registerKnowledgeInputSchema,
  updateKnowledgeInputSchema,
} from "../src/shared/schemas/knowledge.schema.ts";
import { landscapeSnapshotSchema } from "../src/shared/schemas/landscape.schema.ts";
import {
  landscapeReviewItemSchema,
  landscapeReviewItemsMaterializeInputSchema,
} from "../src/shared/schemas/landscape-review.schema.ts";
import { overviewDashboardSchema } from "../src/shared/schemas/overview.schema.ts";
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

  test("registerCandidateInputSchema accepts title/body or text", () => {
    expect(
      registerCandidateInputSchema.parse({
        title: "T",
        body: "B",
        technologies: "bun,typescript",
      }),
    ).toEqual(
      expect.objectContaining({
        title: "T",
        body: "B",
        technologies: ["bun", "typescript"],
      }),
    );
    expect(registerCandidateInputSchema.parse({ text: "TITLE: T\nCONTENT: B" })).toEqual(
      expect.objectContaining({ text: "TITLE: T\nCONTENT: B" }),
    );
    expect(registerCandidateInputSchema.safeParse({ title: "T" }).success).toBe(false);
  });

  test("compileInputSchema parses valid input", () => {
    const input = { goal: "test" };
    expect(compileInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("doctorReportSchema parses valid input", () => {
    const input = {
      status: "ok",
      checkedAt: new Date().toISOString(),
      summary: {
        blocking: 0,
        degraded: 0,
        maintenance: 0,
        skipped: 0,
      },
      reasons: [],
      reasonDetails: [],
      skippedChecks: [],
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
        queueHealth: {
          queued: 0,
          running: 0,
          retryablePaused: 0,
          staleRunning: 0,
          blockedByHigherPriority: false,
          oldestQueuedAt: null,
          oldestQueuedAgeMinutes: null,
          oldestRunningAt: null,
          oldestRunningAgeMinutes: null,
          lock: {
            path: "/tmp/distillation-pipeline.lock",
            exists: false,
            pid: null,
            createdAt: null,
            ageSeconds: null,
            staleByCreatedAge: false,
          },
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
        queueHealth: {
          queued: 0,
          running: 0,
          retryablePaused: 0,
          staleRunning: 0,
          blockedByHigherPriority: false,
          oldestQueuedAt: null,
          oldestQueuedAgeMinutes: null,
          oldestRunningAt: null,
          oldestRunningAgeMinutes: null,
          lock: {
            path: "/tmp/distillation-pipeline.lock",
            exists: false,
            pid: null,
            createdAt: null,
            ageSeconds: null,
            staleByCreatedAge: false,
          },
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

  test("overviewDashboardSchema parses valid input", () => {
    const input = {
      checkedAt: new Date().toISOString(),
      kpis: {
        knowledgeTotal: 10,
        activeKnowledge: 8,
        draftKnowledge: 2,
        deprecatedKnowledge: 0,
        rules: 7,
        procedures: 3,
        embeddedKnowledge: 9,
        zeroUseActiveKnowledge: 4,
        wikiPages: 5,
        indexedSources: 5,
        sourceFragments: 30,
        sourceLinks: 12,
        linkedKnowledge: 6,
        unlinkedKnowledge: 4,
        sourceCommunities: 3,
        sourceCoveredCommunities: 1,
        sourceThinCommunities: 1,
        sourceMissingCommunities: 1,
        vibeRecords: 20,
        vibeSessions: 3,
        vibeRecordsWithDiffs: 14,
        agentDiffEntries: 55,
        compileRuns: 12,
        compileOkRuns: 6,
        compileDegradedRuns: 5,
        compileFailedRuns: 1,
      },
      charts: {
        knowledgeByStatusType: [
          { status: "active", rule: 6, procedure: 2 },
          { status: "draft", rule: 1, procedure: 1 },
          { status: "deprecated", rule: 0, procedure: 0 },
        ],
        dynamicScoreBuckets: [
          { bucket: "0", count: 4 },
          { bucket: "0-1", count: 1 },
          { bucket: "1-5", count: 2 },
          { bucket: "5-10", count: 1 },
          { bucket: "10-15", count: 0 },
          { bucket: "15-20", count: 0 },
          { bucket: "20-25", count: 0 },
          { bucket: "25-30", count: 0 },
          { bucket: "30-35", count: 0 },
          { bucket: "35+", count: 0 },
        ],
        compileRunsByDay: [
          { day: "2026-05-20", ok: 2, degraded: 1, failed: 0, avgDurationMs: 1200 },
          { day: "2026-05-21", ok: 1, degraded: 0, failed: 1, avgDurationMs: null },
        ],
        vibeRecordsByDay: [
          { day: "2026-05-20", records: 3 },
          { day: "2026-05-21", records: 1 },
        ],
        sourceCoverage: [
          { label: "linked", count: 6 },
          { label: "unlinked", count: 4 },
        ],
        communitySourceCoverage: [
          { label: "covered", count: 1 },
          { label: "thin", count: 1 },
          { label: "no-source", count: 1 },
        ],
        distillationQueue: [
          {
            targetKind: "wiki_file",
            pending: 4,
            running: 1,
            paused: 0,
            completed: 2,
            failed: 0,
          },
          {
            targetKind: "vibe_memory",
            pending: 3,
            running: 0,
            paused: 1,
            completed: 1,
            failed: 1,
          },
        ],
      },
      llmUsage: {
        kpis: {
          totalCalls30d: 40,
          measuredCalls30d: 32,
          estimatedCalls30d: 8,
          localTokensTotal30d: 3000,
          localPromptTokens30d: 1200,
          localCompletionTokens30d: 1800,
          cloudTokensTotal30d: 7000,
          cloudPromptTokens30d: 3000,
          cloudCompletionTokens30d: 4000,
          measuredTokensTotal30d: 8500,
          estimatedTokensTotal30d: 1500,
          measuredCoveragePercent30d: 80,
          reasoningTokensTotal30d: 500,
          cloudCostJpyTotal30d: 12.5,
          cloudModel: "gpt-5-4-mini",
          cloudInputCostJpyPerMTokens: 165,
          cloudOutputCostJpyPerMTokens: 660,
        },
        daily: [
          {
            day: "2026-05-20",
            localPromptTokens: 100,
            localCompletionTokens: 200,
            localReasoningTokens: 0,
            cloudPromptTokens: 300,
            cloudCompletionTokens: 400,
            cloudReasoningTokens: 50,
            totalTokens: 1000,
            measuredTokens: 900,
            estimatedTokens: 100,
            measuredCalls: 6,
            estimatedCalls: 1,
            costJpy: 1.25,
          },
        ],
        bySource: [
          {
            source: "context-compiler",
            calls: 20,
            measuredCalls: 16,
            estimatedCalls: 4,
            promptTokens: 2400,
            completionTokens: 1600,
            totalTokens: 4000,
          },
        ],
      },
      searchApiStatus: {
        brave: {
          status: "cooldown",
          cooldownUntil: "2026-05-21T00:00:00.000Z",
          lastError: "Brave search HTTP 429",
        },
        exa: {
          status: "ok",
          cooldownUntil: null,
          lastError: null,
        },
      },
      landscape: {
        status: "ok",
        windowDays: 30,
        generatedAt: "2026-05-21T00:00:00.000Z",
        snapshot: {
          totalCommunities: 12,
          strongAttractorCount: 2,
          usefulAttractorCount: 4,
          negativeCandidateCount: 1,
          overSelectedNotUsedCount: 1,
          deadZoneReachabilityCount: 3,
          deadZoneStaleCount: 0,
          feedbackInsufficientCount: 5,
          topRiskCount: 4,
        },
        replay: {
          comparedRunCount: 20,
          averageOverlapRate: 0.92,
          retainedItemCount: 86,
          missingFromCurrentItemCount: 3,
          newlyRetrievedItemCount: 154,
          usedBaselineLostItemCount: 2,
          highChurnRunCount: 18,
          currentNoMatchRunCount: 0,
          promotionGateMode: "review_required",
        },
      },
    };

    expect(overviewDashboardSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("overviewDashboardSchema parses unavailable landscape summary", () => {
    const input = {
      checkedAt: new Date().toISOString(),
      kpis: {
        knowledgeTotal: 0,
        activeKnowledge: 0,
        draftKnowledge: 0,
        deprecatedKnowledge: 0,
        rules: 0,
        procedures: 0,
        embeddedKnowledge: 0,
        zeroUseActiveKnowledge: 0,
        wikiPages: 0,
        indexedSources: 0,
        sourceFragments: 0,
        sourceLinks: 0,
        linkedKnowledge: 0,
        unlinkedKnowledge: 0,
        sourceCommunities: 0,
        sourceCoveredCommunities: 0,
        sourceThinCommunities: 0,
        sourceMissingCommunities: 0,
        vibeRecords: 0,
        vibeSessions: 0,
        vibeRecordsWithDiffs: 0,
        agentDiffEntries: 0,
        compileRuns: 0,
        compileOkRuns: 0,
        compileDegradedRuns: 0,
        compileFailedRuns: 0,
      },
      charts: {
        knowledgeByStatusType: [],
        dynamicScoreBuckets: [],
        compileRunsByDay: [],
        vibeRecordsByDay: [],
        sourceCoverage: [],
        communitySourceCoverage: [],
        distillationQueue: [],
      },
      llmUsage: {
        kpis: {
          totalCalls30d: 0,
          measuredCalls30d: 0,
          estimatedCalls30d: 0,
          localTokensTotal30d: 0,
          localPromptTokens30d: 0,
          localCompletionTokens30d: 0,
          cloudTokensTotal30d: 0,
          cloudPromptTokens30d: 0,
          cloudCompletionTokens30d: 0,
          measuredTokensTotal30d: 0,
          estimatedTokensTotal30d: 0,
          measuredCoveragePercent30d: 0,
          reasoningTokensTotal30d: 0,
          cloudCostJpyTotal30d: 0,
          cloudModel: "gpt-5-4-mini",
          cloudInputCostJpyPerMTokens: 0,
          cloudOutputCostJpyPerMTokens: 0,
        },
        daily: [],
        bySource: [],
      },
      searchApiStatus: {
        brave: { status: "ok", cooldownUntil: null, lastError: null },
        exa: { status: "ok", cooldownUntil: null, lastError: null },
      },
      landscape: {
        status: "unavailable",
        windowDays: 30,
        error: "landscape unavailable",
      },
    };

    expect(overviewDashboardSchema.parse(input).landscape).toEqual(input.landscape);
  });

  test("landscape review schemas parse valid input", () => {
    const item = {
      id: "review-item-1",
      source: "replay_compare",
      reason: "baseline_wrong",
      status: "pending",
      proposedAction: "review_wrong",
      priority: 95,
      confidence: "medium",
      knowledgeId: "knowledge-1",
      runId: "run-1",
      triggerEventId: null,
      communityKey: null,
      communityLabel: null,
      suggestedAppliesTo: {
        retrievalMode: "task_context",
      },
      evidence: ["wrong feedback observed in baseline replay"],
      payload: {
        generatedBy: "landscape_replay_compare",
      },
      note: null,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
      resolvedAt: null,
    };
    expect(landscapeReviewItemSchema.parse(item)).toEqual(expect.objectContaining(item));

    const materializeInput = {
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      relationAxes: "session,project,source",
      sources: ["replay_compare"],
      materializeLimit: 50,
    };
    expect(landscapeReviewItemsMaterializeInputSchema.parse(materializeInput)).toEqual(
      expect.objectContaining({
        dryRun: true,
        relationAxes: ["session", "project", "source"],
        sources: ["replay_compare"],
      }),
    );
  });

  test("landscapeSnapshotSchema parses valid input", () => {
    const input = {
      generatedAt: "2026-05-24T00:00:00.000Z",
      windowDays: 30,
      basis: {
        unit: "community",
        relationAxes: ["session", "project", "source"],
        status: "active",
      },
      thresholds: {
        minSelectedCount: 3,
        minFeedbackCount: 3,
        feedbackConfidence: { mediumMin: 10, highMin: 30 },
        feedbackFactor: { insufficient: 0.4, low: 0.7, medium: 0.9, high: 1 },
        attractor: {
          strongUsedRateMin: 0.7,
          usefulUsedRateMin: 0.5,
          strongSourceRefDensityMin: 0.6,
        },
        negative: {
          offTopicWeight: 1,
          wrongWeight: 3,
          candidateOffTopicRateMin: 0.4,
        },
        notUsed: {
          overSelectedRateMin: 0.6,
        },
        deadZone: {
          reachabilityRiskMin: 0.3,
          staleSourceRefDensityMax: 0.5,
          staleFactorMin: 0.5,
        },
        evidenceFactor: {
          sourceRefDensityBaseline: 1,
          min: 0.25,
          max: 1.25,
        },
      },
      stats: {
        totalCommunities: 1,
        activeCommunities: 1,
        selectedCommunities: 1,
        insufficientFeedbackCommunities: 0,
        strongAttractorCount: 1,
        usefulAttractorCount: 0,
        negativeCandidateCount: 0,
        overSelectedNotUsedCount: 0,
        deadZoneReachabilityCount: 0,
        deadZoneStaleCount: 0,
      },
      communities: [
        {
          communityId: "community:1",
          communityKey: "a".repeat(64),
          communityLabel: "Core",
          communityRank: 1,
          size: 2,
          memberCounts: {
            active: 2,
            draft: 0,
            deprecated: 0,
            rule: 1,
            procedure: 1,
            embedded: 2,
          },
          selection: {
            selectedItemCountWindow: 8,
            selectedRunCountWindow: 6,
            cumulativeCompileSelectCount: 20,
            zeroUseActiveCount: 0,
            zeroUseActiveRatio: 0,
          },
          feedback: {
            usedCountWindow: 5,
            notUsedCountWindow: 2,
            offTopicCountWindow: 1,
            wrongCountWindow: 0,
            feedbackCountWindow: 8,
            usedRate: 0.625,
            notUsedRate: 0.25,
            offTopicRate: 0.125,
            wrongRate: 0,
            feedbackConfidence: "low",
          },
          quality: {
            avgImportance: 80,
            avgConfidence: 75,
            avgDynamicScore: 21,
            sourceRefCount: 3,
            sourceRefDensity: 1.5,
            avgFreshnessFactor: 0.9,
            avgStalenessFactor: 0.1,
          },
          scores: {
            activity: 8,
            attractorScore: 3.2,
            negativeScore: 0.8,
            reachabilityRiskScore: 0.1,
          },
          classification: {
            primary: "useful_attractor",
            flags: [],
            confidence: "medium",
            reason: "stable",
          },
          recommendedActions: ["keep"],
          representativeKnowledgeIds: ["k1", "k2"],
        },
      ],
      risks: [],
    };

    expect(landscapeSnapshotSchema.parse(input)).toEqual(expect.objectContaining(input));
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

  test("knowledge.schema preprocess and refine edge cases", () => {
    // test optionalKnowledgeScoreSchema preprocess
    const reg1 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      confidence: "", // empty string should map to undefined
      importance: "85", // numeric string should map to 85
    });
    expect(reg1.confidence).toBeUndefined();
    expect(reg1.importance).toBe(85);

    const reg2 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      confidence: null, // null should map to undefined
      importance: 90,
    });
    expect(reg2.confidence).toBeUndefined();
    expect(reg2.importance).toBe(90);

    const regInvalidScore = registerKnowledgeInputSchema.safeParse({
      title: "T",
      body: "B",
      confidence: "invalid-number", // should result in undefined
    });
    expect(regInvalidScore.success).toBe(true);
    if (regInvalidScore.success) {
      expect(regInvalidScore.data.confidence).toBeUndefined();
    }

    // test optionalApplicabilityBooleanSchema preprocess
    const regBool1 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      general: "true",
    });
    expect(regBool1.general).toBe(true);

    const regBool2 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      general: "false",
    });
    expect(regBool2.general).toBe(false);

    const regBoolInvalid = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      general: "not-a-boolean",
    });
    expect(regBoolInvalid.general).toBeUndefined();

    // test optionalApplicabilityArraySchema preprocess
    const regArr1 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      technologies: "node, bun, typescript", // split comma
    });
    expect(regArr1.technologies).toEqual(["node", "bun", "typescript"]);

    const regArr2 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      technologies: ["node", "bun"],
    });
    expect(regArr2.technologies).toEqual(["node", "bun"]);

    const regArrEmpty = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      technologies: "",
    });
    expect(regArrEmpty.technologies).toBeUndefined();

    // test updateKnowledgeInputSchema refine
    const updateValid = updateKnowledgeInputSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "Updated Title",
    });
    expect(updateValid.success).toBe(true);

    const updateInvalid = updateKnowledgeInputSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      // no update fields
    });
    expect(updateInvalid.success).toBe(false);
  });
});
