import { describe, expect, test } from "vitest";
import { buildContextDecisionMlSignal } from "../src/modules/context-decision/context-decision.ml-signal.js";
import {
  normalizeContextDecisionMlFeatures,
  type ContextDecisionMlFeatures,
} from "../src/modules/context-decision/context-decision.ml-features.js";
import type { ContextDecisionMlTrainingRow } from "../src/modules/context-decision/context-decision.repository.js";
import type { ContextDecisionValue } from "../src/shared/schemas/context-decision.schema.js";

function features(overrides: Partial<Record<keyof ContextDecisionMlFeatures, number>> = {}) {
  return normalizeContextDecisionMlFeatures({
    supportHitCount: 3,
    selectedSupportCount: 2,
    supportScore: 80,
    coverageScore: 80,
    deterministicConfidence: 70,
    ...overrides,
  });
}

function row(params: {
  index: number;
  decision?: ContextDecisionValue;
  humanFeedback?: "good" | "bad" | null;
  systemOutcomes?: ContextDecisionMlTrainingRow["systemOutcomes"];
  persistedFeatures?: ContextDecisionMlFeatures | null;
}): ContextDecisionMlTrainingRow {
  return {
    decisionId: `00000000-0000-0000-0000-${String(params.index).padStart(12, "0")}`,
    decision: params.decision ?? "execute",
    confidenceTrace: params.persistedFeatures
      ? { mlSignal: { features: params.persistedFeatures } }
      : {},
    metadata: {},
    humanFeedback: params.humanFeedback ?? null,
    systemOutcomes: params.systemOutcomes ?? ["success"],
    createdAt: "2026-06-10T00:00:00.000Z",
  };
}

describe("context decision ML signal", () => {
  test("returns insufficient_data below the training sample threshold", async () => {
    const signal = await buildContextDecisionMlSignal({
      currentFeatures: features(),
      trainingRows: [row({ index: 1, persistedFeatures: features() })],
    });

    expect(signal.status).toBe("insufficient_data");
    expect(signal.trainingSampleCount).toBe(1);
  });

  test("excludes still_unknown and rows without persisted feature sets", async () => {
    const signal = await buildContextDecisionMlSignal({
      currentFeatures: features(),
      trainingRows: [
        row({ index: 1, persistedFeatures: features(), systemOutcomes: ["still_unknown"] }),
        row({ index: 2, persistedFeatures: null, systemOutcomes: ["success"] }),
      ],
    });

    expect(signal.status).toBe("insufficient_data");
    expect(signal.trainingSampleCount).toBe(0);
  });

  test("human bad outranks system success when building labels", async () => {
    const trainingRows: ContextDecisionMlTrainingRow[] = [];
    for (let index = 1; index <= 20; index += 1) {
      trainingRows.push(
        row({
          index,
          decision: "execute",
          humanFeedback: "good",
          persistedFeatures: features({ supportScore: 85, deterministicConfidence: 78 }),
        }),
      );
    }
    for (let index = 21; index <= 40; index += 1) {
      trainingRows.push(
        row({
          index,
          decision: "execute",
          humanFeedback: "bad",
          systemOutcomes: ["success"],
          persistedFeatures: features({
            supportScore: 25,
            deterministicConfidence: 28,
            selectedSupportCount: 0,
          }),
        }),
      );
    }

    const signal = await buildContextDecisionMlSignal({
      currentFeatures: features({ supportScore: 20, deterministicConfidence: 25 }),
      trainingRows,
    });

    expect(signal.trainingSampleCount).toBe(40);
    expect(signal.classDistribution.execute).toBe(20);
    expect(signal.classDistribution.escalate).toBe(20);
  });

  test("disabled signal does not inspect training rows", async () => {
    const signal = await buildContextDecisionMlSignal({
      currentFeatures: features(),
      trainingRows: [row({ index: 1, persistedFeatures: features() })],
      disabled: true,
    });

    expect(signal.status).toBe("disabled");
    expect(signal.trainingSampleCount).toBe(0);
  });
});
