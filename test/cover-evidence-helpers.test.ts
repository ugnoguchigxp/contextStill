import { describe, expect, test } from "vitest";
import {
  compactReason,
  inferCandidateType,
  inferImportance,
  isRetryableCoverEvidenceStatus,
  makeResult,
  normalizeProcedureBodyQuality,
  requiresExternalEvidence,
} from "../src/modules/coverEvidence/helpers.js";
import { PROCEDURE_BODY_NOT_ACTIONABLE_REASON } from "../src/modules/distillation/procedure-quality.js";

describe("coverEvidence helpers", () => {
  describe("compactReason", () => {
    test("trims and replaces whitespaces", () => {
      expect(compactReason("  some  \n  reason  ")).toBe("some reason");
      expect(compactReason(null)).toBeNull();
      expect(compactReason(undefined)).toBeNull();
    });

    test("truncates long reasons to MAX_REASON_LENGTH (160)", () => {
      const longReason = "a".repeat(200);
      expect(compactReason(longReason)).toHaveLength(160);
    });
  });

  describe("inferImportance", () => {
    test("returns 82 for critical keywords", () => {
      expect(inferImportance("Must do this", "This is required.")).toBe(82);
      expect(inferImportance("安全な設計", "必ず検証してください。")).toBe(82);
      expect(inferImportance("Security vulnerability", "Avoid failure.")).toBe(82);
    });

    test("returns 74 for warning / should keywords", () => {
      expect(inferImportance("Should do this", "Prefer using the new API.")).toBe(74);
      expect(inferImportance("推奨される設計", "注意して進めてください。")).toBe(74);
    });

    test("returns 68 for normal descriptions", () => {
      expect(inferImportance("Hello world", "Some generic info.")).toBe(68);
      expect(inferImportance("一般的な設定", "詳細はこちらを参照。")).toBe(68);
    });
  });

  describe("inferCandidateType", () => {
    test("returns procedure if typeHint is procedure AND workflow signal is present", () => {
      const title = "Setup instructions";
      const body = "1. Run bun install\n2. Run bun test"; // command(bun) + verification(test) + sequence(1.)
      expect(inferCandidateType(title, body, "procedure")).toBe("procedure");
    });

    test("returns procedure if workflow signal is present without a type hint", () => {
      const title = "How to build";
      const body = "1. Run npm install\n2. Run npm test"; // command(npm) + verification(test) + sequence(1.)
      expect(inferCandidateType(title, body)).toBe("procedure");
    });

    test("respects an explicit rule type hint", () => {
      const title = "Test behavior, not implementation";
      const body = "1. Run the nearest test first\n2. Then run the related test range";
      expect(inferCandidateType(title, body, "rule")).toBe("rule");
    });

    test("returns rule otherwise", () => {
      expect(
        inferCandidateType("Use Prepared Statements", "Repeated queries should be prepared."),
      ).toBe("rule");
    });
  });

  describe("normalizeProcedureBodyQuality", () => {
    test("returns input directly if status is not knowledge_ready", () => {
      const input = makeResult({
        status: "insufficient",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Setup instructions",
          body: "Hello",
          importance: 80,
          confidence: 80,
        },
      });
      expect(normalizeProcedureBodyQuality(input)).toBe(input);
    });

    test("returns input directly if candidate type is not procedure", () => {
      const input = makeResult({
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "rule",
          title: "Rule title",
          body: "Rule body",
          importance: 80,
          confidence: 80,
        },
      });
      expect(normalizeProcedureBodyQuality(input)).toBe(input);
    });

    test("returns input directly if body contains skill-like structure", () => {
      const body = [
        "Use when: When deploying new changes.",
        "",
        "Workflow:",
        "1. Build the app.",
        "2. Run verification.",
        "",
        "Verification: Confirm the app runs without crashes.",
        "",
        "Avoid: Do not deploy without running verification.",
      ].join("\n");

      const input = makeResult({
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Deploy app",
          body,
          importance: 80,
          confidence: 80,
        },
      });
      const output = normalizeProcedureBodyQuality(input);
      expect(output.status).toBe("knowledge_ready");
      expect(output.candidate?.type).toBe("procedure");
    });

    test("demotes procedure to rule if it should be demoted", () => {
      const input = makeResult({
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "頻出クエリは Prepared Statement を使う",
          body: "繰り返し実行するクエリは prepare() で Prepared Statement 化して高速化する。",
          importance: 80,
          confidence: 80,
        },
      });
      const output = normalizeProcedureBodyQuality(input);
      expect(output.candidate?.type).toBe("rule");
    });

    test("demotes non-skill procedure output to rule when the original candidate was explicitly a rule", () => {
      const input = makeResult({
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Test behavior, not implementation",
          body: "1. Run the nearest test first.\n2. Then run the related test range.",
          importance: 90,
          confidence: 90,
        },
      });
      const output = normalizeProcedureBodyQuality(input, { typeHint: "rule" });
      expect(output.status).toBe("knowledge_ready");
      expect(output.candidate?.type).toBe("rule");
    });

    test("demotes to insufficient when procedure is not actionable", () => {
      const input = makeResult({
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Invalid procedure with signal",
          body: "1. Run bun test and check.", // has sequence and verification signal, but lacks skill-like sections
          importance: 80,
          confidence: 80,
        },
      });
      const output = normalizeProcedureBodyQuality(input);
      expect(output.status).toBe("insufficient");
      expect(output.reason).toBe(PROCEDURE_BODY_NOT_ACTIONABLE_REASON);
      expect(output.candidate).toBeNull();
    });
  });

  describe("isRetryableCoverEvidenceStatus", () => {
    test("returns true for retryable statuses", () => {
      expect(isRetryableCoverEvidenceStatus("tool_failed")).toBe(true);
      expect(isRetryableCoverEvidenceStatus("provider_failed")).toBe(true);
      expect(isRetryableCoverEvidenceStatus("parse_failed")).toBe(true);
    });

    test("returns false for non-retryable statuses", () => {
      expect(isRetryableCoverEvidenceStatus("knowledge_ready")).toBe(false);
      expect(isRetryableCoverEvidenceStatus("insufficient")).toBe(false);
    });
  });

  describe("requiresExternalEvidence", () => {
    test("returns true if text contains URLs", () => {
      expect(
        requiresExternalEvidence({
          type: "rule",
          title: "Check url",
          body: "Check https://example.com/docs for details",
          importance: 80,
          confidence: 80,
        }),
      ).toBe(true);
    });

    test("returns true if text contains specific tech words", () => {
      expect(
        requiresExternalEvidence({
          type: "rule",
          title: "Latest model",
          body: "Check the latest api limits.",
          importance: 80,
          confidence: 80,
        }),
      ).toBe(true);
    });

    test("returns false otherwise", () => {
      expect(
        requiresExternalEvidence({
          type: "rule",
          title: "Some rule",
          body: "Just some internal business logic.",
          importance: 80,
          confidence: 80,
        }),
      ).toBe(false);
    });
  });
});
