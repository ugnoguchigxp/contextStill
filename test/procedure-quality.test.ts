import { describe, expect, test } from "vitest";
import {
  assessProcedureQuality,
  hasProcedureWorkflowSignal,
  hasSkillLikeProcedureBody,
  shouldDemoteProcedureToRule,
} from "../src/modules/distillation/procedure-quality.js";
import { assessRuleQuality, hasRuleLikeBody } from "../src/modules/distillation/rule-quality.js";

describe("procedure-quality tests", () => {
  describe("hasSkillLikeProcedureBody", () => {
    test("returns true for a well-structured procedure body with at least 2 steps", () => {
      const body = `
Use when:
We need to test this module.

Workflow:
1. First step to verify
2. Second step to verify

Verification:
Check the coverage report.

Avoid:
Avoid skipping tests.
`;
      expect(hasSkillLikeProcedureBody(body)).toBe(true);
    });

    test("returns false when Use when is missing", () => {
      const body = `
Workflow:
1. First step
2. Second step

Verification:
Check the report.

Avoid:
Avoid issues.
`;
      expect(hasSkillLikeProcedureBody(body)).toBe(false);
    });

    test("returns false when Workflow is missing or before Use when", () => {
      const bodyWorkflowBefore = `
Workflow:
1. First step
2. Second step

Use when:
We need to test.

Verification:
Check report.

Avoid:
Avoid issues.
`;
      expect(hasSkillLikeProcedureBody(bodyWorkflowBefore)).toBe(false);
    });

    test("returns false when Verification is missing or before Workflow", () => {
      const bodyVerificationBefore = `
Use when:
We need to test.

Verification:
Check report.

Workflow:
1. First step
2. Second step

Avoid:
Avoid issues.
`;
      expect(hasSkillLikeProcedureBody(bodyVerificationBefore)).toBe(false);
    });

    test("returns false when Avoid is missing or before Verification", () => {
      const bodyAvoidBefore = `
Use when:
We need to test.

Workflow:
1. First step
2. Second step

Avoid:
Avoid issues.

Verification:
Check report.
`;
      expect(hasSkillLikeProcedureBody(bodyAvoidBefore)).toBe(false);
    });

    test("returns false when workflow has fewer than 2 steps", () => {
      const bodyOneStep = `
Use when:
We need to test.

Workflow:
1. Only one step here

Verification:
Check report.

Avoid:
Avoid issues.
`;
      expect(hasSkillLikeProcedureBody(bodyOneStep)).toBe(false);
    });

    test("returns false when workflow steps are empty lines or malformed step numbers", () => {
      const bodyEmptySteps = `
Use when:
We need to test.

Workflow:
1. 
- 
Just text without step marker.

Verification:
Check report.

Avoid:
Avoid issues.
`;
      expect(hasSkillLikeProcedureBody(bodyEmptySteps)).toBe(false);
    });
  });

  describe("hasProcedureWorkflowSignal", () => {
    test("returns true if hasSkillLikeProcedureBody is true", () => {
      const body = `
Use when:
We need to test this module.

Workflow:
1. First step to verify
2. Second step to verify

Verification:
Check the coverage report.

Avoid:
Avoid skipping tests.
`;
      expect(hasProcedureWorkflowSignal("Test Title", body)).toBe(true);
    });

    test("returns true if hasWorkflowMarker is true and hasSequenceMarker is true", () => {
      // Workflow marker: "手順", Sequence marker: "次に"
      expect(hasProcedureWorkflowSignal("手順について", "次に進みます。")).toBe(true);
      // Workflow marker: "workflow", Sequence marker: "step"
      expect(hasProcedureWorkflowSignal("My workflow", "This is step one.")).toBe(true);
    });

    test("returns true if hasWorkflowMarker is true and hasCommandMarker is true", () => {
      // Workflow marker: "runbook", Command marker: "`npm run test`"
      expect(
        hasProcedureWorkflowSignal("runbook for release", "Execute `npm run test` here."),
      ).toBe(true);
      // Workflow marker: "運用", Command marker: "bun"
      expect(hasProcedureWorkflowSignal("運用について", "まずは bun コマンドを実行します。")).toBe(
        true,
      );
    });

    test("returns true if hasWorkflowMarker is true and hasVerificationMarker is true", () => {
      // Workflow marker: "playbook", Verification marker: "verify"
      expect(hasProcedureWorkflowSignal("playbook", "Please verify the deployment.")).toBe(true);
      // Workflow marker: "復旧", Verification marker: "検証"
      expect(hasProcedureWorkflowSignal("復旧手順", "動作を検証してください。")).toBe(true);
    });

    test("returns false if hasWorkflowMarker is true but no other markers are present", () => {
      expect(hasProcedureWorkflowSignal("復旧について", "何か問題が発生しました。")).toBe(false);
    });

    test("returns true if hasSequenceMarker and hasCommandMarker are both true", () => {
      // Sequence: "first", Command: "git"
      expect(hasProcedureWorkflowSignal("Title", "First, run git pull.")).toBe(true);
    });

    test("returns true if hasSequenceMarker and hasVerificationMarker are both true", () => {
      // Sequence: "finally", Verification: "test"
      expect(hasProcedureWorkflowSignal("Title", "Finally, run test.")).toBe(true);
    });

    test("returns false if only sequence marker is present", () => {
      expect(hasProcedureWorkflowSignal("Title", "First, do nothing.")).toBe(false);
    });

    test("returns false if only command marker is present", () => {
      expect(hasProcedureWorkflowSignal("Title", "Using docker container.")).toBe(false);
    });

    test("returns false if only verification marker is present", () => {
      expect(hasProcedureWorkflowSignal("Title", "This is a smoke test.")).toBe(false);
    });

    test("returns false if no markers are present at all", () => {
      expect(
        hasProcedureWorkflowSignal(
          "Hello World",
          "Simple text content without any workflows or commands.",
        ),
      ).toBe(false);
    });
  });

  describe("shouldDemoteProcedureToRule", () => {
    test("returns false if both procedure and rule quality are weak", () => {
      const params = {
        title: "Hello World",
        body: "Simple text content without any workflows or commands.",
      };
      expect(shouldDemoteProcedureToRule(params)).toBe(false);
    });

    test("returns true if body is not a procedure but is rule-like", () => {
      const params = {
        title: "Use prepared statements",
        body: "Repeated queries should use prepared statements instead of raw string queries.",
      };
      expect(shouldDemoteProcedureToRule(params)).toBe(true);
    });

    test("returns false if hasSkillLikeProcedureBody is true", () => {
      const params = {
        title: "A Valid Procedure",
        body: `
Use when:
We need to test this module.

Workflow:
1. First step to verify
2. Second step to verify

Verification:
Check the coverage report.

Avoid:
Avoid skipping tests.
`,
      };
      expect(shouldDemoteProcedureToRule(params)).toBe(false);
    });

    test("returns false if hasProcedureWorkflowSignal is true (even if body is not fully structured)", () => {
      const params = {
        title: "運用手順",
        body: "次に bun コマンドを実行します。",
      };
      expect(shouldDemoteProcedureToRule(params)).toBe(false);
    });
  });

  describe("rule quality", () => {
    test("accepts explicit actionable rules", () => {
      expect(
        hasRuleLikeBody({
          title: "Test behavior, not implementation",
          body: "Run behavior tests first and avoid private method tests.",
          explicitRule: true,
        }),
      ).toBe(true);
      expect(
        assessRuleQuality({
          title: "Test behavior, not implementation",
          body: "Run behavior tests first and avoid private method tests.",
          explicitRule: true,
        }).action,
      ).toBe("accept_rule");
    });

    test("rejects vague rule bodies", () => {
      expect(
        assessRuleQuality({
          title: "Maybe useful",
          body: "This seems important.",
          explicitRule: true,
        }),
      ).toMatchObject({
        action: "reject_rule",
        reason: "rule_body_not_actionable",
      });
    });
  });

  describe("assessProcedureQuality", () => {
    test("routes explicit rule type through rule quality", () => {
      expect(
        assessProcedureQuality({
          title: "Keep source evidence",
          body: "coverEvidence must preserve source references before finalizeDistille stores drafts.",
          typeHint: "rule",
        }),
      ).toMatchObject({
        action: "demote_to_rule",
        reason: "explicit_rule_type",
      });
    });

    test("marks procedure-like non-skill bodies as repair candidates", () => {
      expect(
        assessProcedureQuality({
          title: "Repair runbook",
          body: "First run bun test, then verify the output.",
        }),
      ).toMatchObject({
        action: "repair_procedure",
      });
    });
  });
});
