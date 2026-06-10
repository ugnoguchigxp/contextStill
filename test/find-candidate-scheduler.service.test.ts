import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { decideFindCandidateSchedule } from "../src/modules/findCandidate/find-candidate-scheduler.service.js";

// クエリ結果解決用のキュー
let mockDbResults: any[] = [];

// db client のモック
vi.mock("../src/db/client.js", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((resolve) => {
      resolve(mockDbResults.shift() ?? []);
    }),
  };
  return {
    db: mockDb,
  };
});

// config モック (schema読み込み時に embedding.dimension が必要)
vi.mock("../src/config.js", () => ({
  groupedConfig: {
    embedding: {
      dimension: 1536,
    },
    distillation: {
      findCandidateBackgroundEnabled: true,
      findCandidateNoWait: false,
      findCandidateMinIntervalSeconds: 10,
      findCandidateInteractiveWindowSeconds: 60,
      findCandidateRecentBlockSeconds: 15,
    },
  },
}));

// llm resolver モック
const mockResolveProviderForDistillation = vi.fn();
const mockResolveDistillationModel = vi.fn();
vi.mock("../src/modules/distillation/llm-resolver.js", () => ({
  resolveProviderForDistillation: (...args: any[]) => mockResolveProviderForDistillation(...args),
  resolveDistillationModel: (...args: any[]) => mockResolveDistillationModel(...args),
}));

// provider pressure モック
const mockJitterMs = vi.fn();
const mockReadProviderPressureState = vi.fn();
const mockResolveFindCandidateThrottleSeconds = vi.fn();
vi.mock("../src/modules/llm/provider-pressure.service.js", () => ({
  jitterMs: (...args: any[]) => mockJitterMs(...args),
  readProviderPressureState: (...args: any[]) => mockReadProviderPressureState(...args),
  resolveFindCandidateThrottleSeconds: (...args: any[]) =>
    mockResolveFindCandidateThrottleSeconds(...args),
}));

// settings service モック
const mockEnsureRuntimeSettingsLoaded = vi.fn();
const mockResolveFindCandidateRoute = vi.fn();
vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: (...args: any[]) => mockEnsureRuntimeSettingsLoaded(...args),
  resolveFindCandidateRoute: (...args: any[]) => mockResolveFindCandidateRoute(...args),
}));

describe("find-candidate-scheduler.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbResults = [];
    mockResolveFindCandidateRoute.mockReturnValue({ provider: "openai" });
    mockResolveProviderForDistillation.mockReturnValue("openai");
    mockResolveDistillationModel.mockReturnValue("gpt-4");
    mockJitterMs.mockReturnValue(50);
    groupedConfig.distillation.findCandidateBackgroundEnabled = true;
    groupedConfig.distillation.findCandidateNoWait = false;
  });

  test("returns disabled wait decision if findCandidateBackgroundEnabled is false", async () => {
    groupedConfig.distillation.findCandidateBackgroundEnabled = false;

    const result = await decideFindCandidateSchedule({
      targetKind: "wiki_file",
    });

    expect(result.shouldWait).toBe(true);
    expect(result.waitMs).toBe(10000); // minInterval (10) * 1000
    expect(result.reason).toBe("disabled");
  });

  test("returns ready immediately if findCandidateNoWait is true", async () => {
    groupedConfig.distillation.findCandidateNoWait = true;

    const result = await decideFindCandidateSchedule({
      targetKind: "wiki_file",
    });

    expect(result.shouldWait).toBe(false);
    expect(result.waitMs).toBe(0);
    expect(result.reason).toBe("ready");
  });

  test("returns provider_cooldown if provider cooldown is active", async () => {
    mockReadProviderPressureState.mockResolvedValue({
      cooldownActive: true,
      waitMs: 5000,
      metadata: { lastBackgroundAt: new Date(Date.now() - 5000).toISOString() },
    });

    const result = await decideFindCandidateSchedule({
      targetKind: "wiki_file",
    });

    expect(result.shouldWait).toBe(true);
    expect(result.waitMs).toBe(5050); // waitMs (5000) + jitter (50)
    expect(result.reason).toBe("provider_cooldown");
  });

  test("returns recent_interactive_compile if recent interactive compile exists within block window", async () => {
    mockReadProviderPressureState.mockResolvedValue({
      cooldownActive: false,
      metadata: { lastBackgroundAt: null },
    });
    // compileRow.lastCreatedAt max and llmUsageLogs count
    mockDbResults = [
      [{ count: 2, lastCreatedAt: new Date(Date.now() - 5000) }], // compile runs
      [{ count: 10 }], // usage logs
    ];

    const result = await decideFindCandidateSchedule({
      targetKind: "wiki_file",
    });

    expect(result.shouldWait).toBe(true);
    // recent block is 15. elapsed is 5. remaining is 10.
    // waitMs = 10 * 1000 + 50 (jitter) = 10050
    expect(result.waitMs).toBe(10050);
    expect(result.reason).toBe("recent_interactive_compile");
  });

  test("returns interactive_pressure if throttle calculation requires a wait", async () => {
    mockReadProviderPressureState.mockResolvedValue({
      cooldownActive: false,
      metadata: { lastBackgroundAt: new Date(Date.now() - 20000).toISOString() }, // elapsed = 20s
    });
    mockDbResults = [
      [{ count: 0, lastCreatedAt: null }], // compile runs
      [{ count: 0 }], // usage logs
    ];
    // throttle returns 30s interval
    mockResolveFindCandidateThrottleSeconds.mockReturnValue(30);

    const result = await decideFindCandidateSchedule({
      targetKind: "wiki_file",
    });

    expect(result.shouldWait).toBe(true);
    // wait seconds = max(0, 30 - 20) = 10s.
    // waitMs = 10000 + 50 (jitter) = 10050
    expect(result.waitMs).toBe(10050);
    expect(result.reason).toBe("interactive_pressure");
  });

  test("returns ready if throttle calculation requires no wait", async () => {
    mockReadProviderPressureState.mockResolvedValue({
      cooldownActive: false,
      metadata: { lastBackgroundAt: new Date(Date.now() - 40000).toISOString() }, // elapsed = 40s
    });
    mockDbResults = [
      [{ count: 0, lastCreatedAt: null }], // compile runs
      [{ count: 0 }], // usage logs
    ];
    mockResolveFindCandidateThrottleSeconds.mockReturnValue(30);

    const result = await decideFindCandidateSchedule({
      targetKind: "wiki_file",
    });

    expect(result.shouldWait).toBe(false);
    expect(result.waitMs).toBe(0);
    expect(result.reason).toBe("ready");
  });
});
