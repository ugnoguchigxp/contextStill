import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexResearchEvent } from "../src/modules/manual-research/codex-research.js";
import { exploreWithCodex } from "../src/modules/manual-research/codex-research.js";
import {
  codexResearchOptionsSchema,
  researchCandidateSchema,
} from "../src/modules/manual-research/codex-research.contract.js";

const sdk = vi.hoisted(() => ({ constructor: vi.fn(), start: vi.fn(), run: vi.fn() }));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: unknown) {
      sdk.constructor(options);
    }
    startThread(options: unknown) {
      sdk.start(options);
      return { runStreamed: sdk.run };
    }
  },
}));
vi.mock("../src/modules/codex/spark-runtime.js", () => ({
  resolveCodexExecutable: () => "/fake/codex",
}));

const candidate = {
  title: "安全な再試行",
  knowledge: "再送は冪等キーを使う。",
  relevance: "二重処理を防ぐ。",
  sources: [
    {
      url: "https://example.com/docs",
      title: "一次資料",
      verification: "source_read" as const,
      excerpt: "idempotency key",
      location: "Retry section",
      informationDate: null,
    },
  ],
  uncertainties: ["保持期間は不明"],
  contradictions: [],
};
const message = (
  text = JSON.stringify({ candidates: [candidate], limitations: [] }),
): CodexResearchEvent => ({
  type: "item.completed",
  item: { id: "answer", type: "agent_message", text },
});
const complete: CodexResearchEvent = {
  type: "turn.completed",
  usage: {
    input_tokens: 700,
    cached_input_tokens: 500,
    output_tokens: 100,
    reasoning_output_tokens: 30,
  },
};
function fixture(events: CodexResearchEvent[]) {
  const close = vi.fn(async () => {});
  const openThread = vi.fn(async () => ({
    close,
    thread: {
      runStreamed: vi.fn(async () => ({
        events: (async function* () {
          yield* events;
        })(),
      })),
    },
  }));
  return { openThread, close };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Codex public web exploration", () => {
  it("returns validated candidates and keeps cached model input separate", async () => {
    const session = fixture([message(), complete]);
    const result = await exploreWithCodex("再試行", codexResearchOptionsSchema.parse({}), session);
    expect(result.termination).toBe("completed");
    expect(result.candidates[0]).toEqual(candidate);
    expect(result.tokenUsage).toEqual({
      inputTokens: 700,
      cachedInputTokens: 500,
      outputTokens: 100,
      reasoningOutputTokens: 30,
    });
    expect(result.usageComplete).toBe(true);
    expect(session.openThread).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("detects the target budget at completion without double counting cached tokens", async () => {
    const result = await exploreWithCodex(
      "再試行",
      codexResearchOptionsSchema.parse({ tokenBudget: 1000 }),
      fixture([message(), { ...complete, usage: { ...complete.usage, input_tokens: 900 } }]),
    );
    expect(result.termination).toBe("token_budget");
    expect(result.candidates).toHaveLength(1);
    const under = await exploreWithCodex(
      "再試行",
      codexResearchOptionsSchema.parse({ tokenBudget: 1000 }),
      fixture([message(), complete]),
    );
    expect(under.termination).toBe("completed");
  });

  it("preserves checkpoint candidates on timeout, aborts the SDK, and leaves usage unknown", async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn(async () => {});
    let aborted = false;
    const close = vi.fn(async () => {});
    const promise = exploreWithCodex("再試行", codexResearchOptionsSchema.parse({ wallMs: 1000 }), {
      onCheckpoint: checkpoint,
      openThread: async () => ({
        close,
        thread: {
          runStreamed: async (_, options) => ({
            events: (async function* () {
              yield message();
              await new Promise<void>((_, reject) =>
                options?.signal?.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(new Error("AbortError"));
                  },
                  { once: true },
                ),
              );
            })(),
          }),
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(aborted).toBe(true);
    expect(result.termination).toBe("timeout");
    expect(result.candidates).toHaveLength(1);
    expect(result.tokenUsage.inputTokens).toBeNull();
    expect(result.usageComplete).toBe(false);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps prior candidates on failure and never retries", async () => {
    const session = fixture([message(), { type: "turn.failed", error: { message: "quota" } }]);
    const result = await exploreWithCodex("再試行", codexResearchOptionsSchema.parse({}), session);
    expect(result.termination).toBe("failed");
    expect(result.candidates).toHaveLength(1);
    expect(session.openThread).toHaveBeenCalledOnce();
  });

  it("distinguishes cancellation and does not launch an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = fixture([]);
    const result = await exploreWithCodex("再試行", codexResearchOptionsSchema.parse({}), {
      ...session,
      signal: controller.signal,
    });
    expect(result.termination).toBe("cancelled");
    expect(session.openThread).not.toHaveBeenCalled();
  });

  it("rejects invalid final data and preserves the last valid checkpoint", async () => {
    const result = await exploreWithCodex(
      "再試行",
      codexResearchOptionsSchema.parse({}),
      fixture([message(), message("{}"), complete]),
    );
    expect(result.termination).toBe("invalid_result");
    expect(result.candidates).toHaveLength(1);
    expect(
      researchCandidateSchema.safeParse({
        ...candidate,
        sources: [{ ...candidate.sources[0], url: "file:///secret" }],
      }).success,
    ).toBe(false);
    expect(
      researchCandidateSchema.safeParse({
        ...candidate,
        sources: [{ ...candidate.sources[0], excerpt: "", location: "" }],
      }).success,
    ).toBe(false);
  });

  it("does not manufacture candidates for evidence gaps", async () => {
    const result = await exploreWithCodex(
      "再試行",
      codexResearchOptionsSchema.parse({}),
      fixture([message(JSON.stringify({ candidates: [], limitations: ["原文未確認"] })), complete]),
    );
    expect(result.termination).toBe("insufficient_evidence");
    expect(result.candidates).toEqual([]);
  });

  it("observes web item limits without counting item updates again", async () => {
    const event = (id: string, type: "item.started" | "item.completed"): CodexResearchEvent => ({
      type,
      item: { id, type: "web_search", query: "retry" },
    });
    const result = await exploreWithCodex(
      "再試行",
      codexResearchOptionsSchema.parse({ maxWebSearches: 1 }),
      fixture([
        message(),
        event("a", "item.started"),
        event("a", "item.completed"),
        event("b", "item.started"),
        complete,
      ]),
    );
    expect(result.termination).toBe("web_limit");
    expect(result.observedWebSearches).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.tokenUsage.inputTokens).toBeNull();
  });

  it("stops on checkpoint persistence failure", async () => {
    const result = await exploreWithCodex("再試行", codexResearchOptionsSchema.parse({}), {
      ...fixture([message(), complete]),
      onCheckpoint: async () => {
        throw new Error("DB offline");
      },
    });
    expect(result.termination).toBe("failed");
    expect(result.tokenUsage.inputTokens).toBeNull();
  });

  it("isolates SDK tools and uses only Luna 6.0 low or medium", async () => {
    sdk.run.mockResolvedValue({
      events: (async function* () {
        yield message();
        yield complete;
      })(),
    });
    const result = await exploreWithCodex(
      "再試行",
      codexResearchOptionsSchema.parse({ reasoningEffort: "medium" }),
    );
    expect(result.termination).toBe("completed");
    expect(sdk.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "gpt-6-luna",
        modelReasoningEffort: "medium",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "live",
        skipGitRepoCheck: true,
      }),
    );
    const options = sdk.constructor.mock.calls.at(-1)?.[0];
    expect(options.config.features).toMatchObject({
      shell_tool: false,
      multi_agent: false,
      apps: false,
      plugins: false,
      goals: false,
    });
    expect(options.env.CODEX_HOME).toContain("contextstill-codex-research-");
    expect(options.env.DEEPSTILL_CONTEXTSTILL_TOKEN).toBeUndefined();
    expect(codexResearchOptionsSchema.safeParse({ reasoningEffort: "high" }).success).toBe(false);
    expect(codexResearchOptionsSchema.safeParse({ wallMs: 300001 }).success).toBe(false);
  });
});
