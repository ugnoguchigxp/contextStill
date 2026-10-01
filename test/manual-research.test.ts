import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectDeepStillResult } from "../src/modules/manual-research/deepstill-client.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function detail() {
  const sourceText = "根拠となる引用。追加の説明。";
  const quote = "根拠となる引用。";
  return {
    job: {
      id: "63cc9880-9d2a-4bf2-a1d8-506a331400d6",
      topic: "調査テーマ",
      mode: "live" as const,
      status: "completed" as const,
      reason: null,
      integration: {
        idempotencyKey: "manual-run-1",
        requestHash: `sha256:${"a".repeat(64)}`,
        disableKnowledge: true as const,
      },
      usage: { queries: 1, urls: 1, tokens: 100, requests: 2, costUsd: 0.01 },
    },
    artifacts: [
      {
        id: "report-1",
        version: 1,
        title: "調査結果",
        body: "確認した内容",
        claimIds: ["claim-1"],
        limitations: [],
        openQuestions: [],
      },
    ],
    claims: [
      { id: "claim-1", text: "確認できた主張", accepted: true, evidenceIds: ["evidence-1"] },
    ],
    evidence: [{ id: "evidence-1", snapshotId: "source-1", quote, start: 0, end: quote.length }],
    sources: [
      {
        id: "source-1",
        title: "一次資料",
        finalUrl: "https://example.com/source",
        text: sourceText,
        hash: hash(sourceText),
      },
    ],
  };
}

describe("manual DeepStill result projection", () => {
  it("keeps the report and verified source quote", () => {
    const projection = projectDeepStillResult(detail());
    expect(projection.result.report?.title).toBe("調査結果");
    expect(projection.result.evidence[0]?.quote).toBe("根拠となる引用。");
    expect(projection.resultHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects altered evidence before displaying a completed result", () => {
    const tampered = detail();
    tampered.evidence[0].quote = "別の引用";
    expect(() => projectDeepStillResult(tampered)).toThrow("DEEPSTILL_EVIDENCE_INVALID");
  });

  it("requires a report for completed research", () => {
    const missing = detail();
    missing.artifacts = [];
    expect(() => projectDeepStillResult(missing)).toThrow("DEEPSTILL_REPORT_MISSING");
  });
});
