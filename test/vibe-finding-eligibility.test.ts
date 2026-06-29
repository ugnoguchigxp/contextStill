import { describe, expect, test } from "vitest";
import { evaluateVibeFindingEligibility } from "../src/modules/findCandidate/vibe-finding-eligibility.js";

describe("evaluateVibeFindingEligibility", () => {
  test("rejects boilerplate-only memories", () => {
    const result = evaluateVibeFindingEligibility({
      id: "memory-1",
      sessionId: "session-1",
      content: [
        "USER: # AGENTS.md instructions for /repo",
        "<INSTRUCTIONS>",
        "このプロジェクトでの作業を開始する際、最初に一度だけ initial_instructions MCP ツールを実行してください。",
        "</INSTRUCTIONS>",
        "<environment_context><cwd>/repo</cwd></environment_context>",
        "<filesystem><workspace_roots><root>/repo</root></workspace_roots></filesystem>",
      ].join("\n"),
      minContentChars: 1,
    });

    expect(result.eligible).toBe(false);
    expect(result.rejectReasons).toContain("boilerplate_heavy");
  });

  test("rejects progress-only memories", () => {
    const result = evaluateVibeFindingEligibility({
      id: "memory-2",
      sessionId: "session-1",
      content: "ASSISTANT: 確認します。",
      minContentChars: 1,
    });

    expect(result.eligible).toBe(false);
    expect(result.rejectReasons).toContain("progress_only");
  });

  test("accepts reusable finding signals with verification and diff material", () => {
    const result = evaluateVibeFindingEligibility({
      id: "memory-3",
      sessionId: "session-1",
      content: [
        "USER: queue の復旧手順を直してください。",
        "ASSISTANT: 原因は provider retry と source_missing が混ざっていたことです。",
        "ASSISTANT: sqlite3 で finding_candidate_queue を確認し、bunx vitest run test/queue-worker.test.ts が通りました。",
      ].join("\n\n"),
      metadata: { roles: ["user", "assistant"], agentDiffCount: 1 },
      agentDiffCount: 1,
      minContentChars: 1,
    });

    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.signals).toEqual(
      expect.arrayContaining([
        "verification_or_failure_terms",
        "has_agent_diff",
        "mixed_roles",
        "runtime_or_queue_terms",
        "command_terms",
      ]),
    );
  });
});
