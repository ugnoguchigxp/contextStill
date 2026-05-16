import { expect, test } from "@playwright/test";

const doctorPayload = {
  status: "ok",
  checkedAt: "2026-05-15T00:00:00.000Z",
  reasons: [],
  db: { reachable: true, durationMs: 8 },
  vector: { installed: true },
  embedding: {
    configured: true,
    provider: "daemon",
    daemon: { url: "http://127.0.0.1:44512", reachable: true },
    cli: {
      python: "/usr/bin/python3",
      root: "/tmp/embedding",
      modelDir: "/tmp/model",
      usable: true,
    },
  },
  tables: { expected: ["knowledge_items"], existing: ["knowledge_items"], missing: [] },
  runs: {
    windowSize: 20,
    totalRuns: 3,
    degradedRuns: 1,
    degradedRate: 0.33,
    durationMsP50: 84,
    durationMsP95: 152,
    durationMsAvg: 98,
    lastRunAt: "2026-05-15T00:00:00.000Z",
    lastRunAgeMinutes: 10,
    freshnessThresholdMinutes: 720,
    degradedRateThreshold: 0.5,
  },
  hitl: {
    draftCount: 2,
    oldestDraftAt: "2026-05-14T00:00:00.000Z",
    oldestDraftAgeMinutes: 1200,
    draftFromSourceDistillationCount: 1,
    draftFromVibeDistillationCount: 1,
    backlogThresholdCount: 50,
    backlogThresholdAgeMinutes: 4320,
  },
  mcp: {
    exposedTools: ["context_compile"],
    requiredPrimaryTools: ["context_compile"],
    missingPrimaryTools: [],
    staleKnowledgeCount: 0,
    staleSourceCount: 0,
    nextActions: [],
  },
  agentLogSync: {
    codex: {
      sessionDir: "/tmp/codex",
      sessionDirExists: true,
      archivedSessionDir: "/tmp/codex-archived",
      archivedSessionDirExists: true,
    },
    antigravity: {
      logDir: "/tmp/antigravity",
      configured: true,
      exists: true,
    },
    states: [],
    launchAgent: {
      label: "memory-router.agent-log-sync",
      plistPath: "/tmp/agent-log-sync.plist",
      installed: true,
      loaded: true,
      state: "loaded",
    },
    nextActions: [],
  },
  vibeDistillation: {
    launchAgent: {
      label: "memory-router.vibe-distillation",
      plistPath: "/tmp/vibe-distillation.plist",
      installed: true,
      loaded: true,
      state: "loaded",
    },
    runs: {
      totalRuns: 1,
      okRuns: 1,
      skippedRuns: 0,
      failedRuns: 0,
      lastRunAt: "2026-05-15T00:00:00.000Z",
      lastRunAgeMinutes: 20,
    },
    nextActions: [],
  },
  sourceDistillation: {
    launchAgent: {
      label: "memory-router.source-distillation",
      plistPath: "/tmp/source-distillation.plist",
      installed: true,
      loaded: true,
      state: "loaded",
    },
    runs: {
      totalRuns: 1,
      okRuns: 1,
      skippedRuns: 0,
      failedRuns: 0,
      lastRunAt: "2026-05-15T00:00:00.000Z",
      lastRunAgeMinutes: 20,
    },
    nextActions: [],
  },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/doctor", async (route) => {
    await route.fulfill({ json: doctorPayload });
  });
  await page.route("**/api/knowledge**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({
      json: {
        items: [
          {
            id: "k-1",
            type: "rule",
            status: "draft",
            scope: "repo",
            title: "Knowledge row one",
            body: "First knowledge body",
            confidence: 80,
            importance: 70,
            sourceRefs: ["file:///docs/rule.md#L1"],
            sourceVibeMemoryIds: ["vm-1"],
            metadata: {},
            updatedAt: "2026-05-15T00:00:00.000Z",
          },
        ],
      },
    });
  });
  await page.route("**/api/vibe-memory**", async (route) => {
    await route.fulfill({ json: { memories: [] } });
  });
  await page.route("**/api/graph**", async (route) => {
    await route.fulfill({
      json: {
        nodes: [],
        edges: [],
        stats: {
          visibleKnowledgeCount: 0,
          totalKnowledgeCount: 0,
          embeddedKnowledgeCount: 0,
          semanticEdgeCount: 0,
          sessionEdgeCount: 0,
          projectEdgeCount: 0,
          relationEdgeCount: 0,
          sourceRefCount: 0,
        },
      },
    });
  });
  await page.route("**/api/sources/tree", async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            slug: "guides/setup",
            title: "Setup Guide",
            path: "guides/setup",
            updatedAt: "2026-05-15T00:00:00.000Z",
          },
        ],
        folders: [{ path: "guides" }],
      },
    });
  });
  await page.route("**/api/sources/health", async (route) => {
    await route.fulfill({
      json: {
        app: "memory-router",
        version: "0.1.0",
        git: { branch: "main", commit: "abc1234" },
      },
    });
  });
  await page.route("**/api/sources/pages/**", async (route) => {
    await route.fulfill({
      json: {
        slug: "guides/setup",
        title: "Setup Guide",
        body: "# setup",
        path: "guides/setup",
        meta: {},
      },
    });
  });
  await page.route("**/api/sources/history/**", async (route) => {
    await route.fulfill({
      json: {
        slug: "guides/setup",
        items: [],
      },
    });
  });
  await page.route("**/api/sources/diff/**", async (route) => {
    await route.fulfill({ json: { diff: "" } });
  });
  await page.route("**/api/sources/search**", async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/context/runs**", async (route) => {
    await route.fulfill({
      json: {
        runs: [
          {
            id: "run-1",
            goal: "sample run",
            intent: "edit",
            retrievalMode: "task_context",
            status: "ok",
            degradedReasons: [],
            durationMs: 90,
            createdAt: "2026-05-15T00:00:00.000Z",
          },
        ],
      },
    });
  });
  await page.route("**/api/context/compile", async (route) => {
    await route.fulfill({
      json: {
        pack: {
          runId: "run-1",
          goal: "compiled",
          intent: "edit",
          retrievalMode: "task_context",
          status: "ok",
          minimalTasks: [],
          rules: [],
          procedures: [],
          codeContext: [],
          warnings: [],
          sourceRefs: [],
          diagnostics: {
            degradedReasons: [],
            retrievalStats: {
              suggestedNextCalls: [],
            },
          },
        },
      },
    });
  });
});

test("Overview and doctor pages are reachable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Context Compiler Control Plane")).toBeVisible();

  await page.getByRole("link", { name: "Doctor" }).click();
  await expect(page.getByRole("heading", { name: "Doctor" })).toBeVisible();
  await expect(page.getByText("compile latency p50")).toBeVisible();
});

test("Knowledge and sources pages show core UI", async ({ page }) => {
  await page.goto("/knowledge");
  await expect(page.getByText("Knowledge row one")).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate selected" })).toBeVisible();
  await page.getByLabel("select-k-1").check();
  await expect(page.getByText("Selected 1 / Visible 1")).toBeVisible();
  await page.getByRole("button", { name: "Show evidence" }).click();
  await expect(page.getByText("file:///docs/rule.md#L1")).toBeVisible();

  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "Explorer" })).toBeVisible();
  await expect(page.getByText("page: guides/setup").first()).toBeVisible();
});

test("Compile page shows validation error when goal is empty", async ({ page }) => {
  let compileCalled = false;
  page.on("request", (request) => {
    if (request.url().includes("/api/context/compile")) {
      compileCalled = true;
    }
  });

  await page.goto("/compile");
  await page.getByRole("button", { name: "Compile" }).click();
  await expect(page.getByText("Goal is required.")).toBeVisible();
  expect(compileCalled).toBe(false);
});
