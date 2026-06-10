import { describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCorpusKnowledgePriorFromRows,
  loadCorpusKnowledgePrior,
  writeCorpusKnowledgePrior,
  type CorpusKnowledgePriorRow,
} from "../src/modules/context-decision/context-decision.corpus-prior.js";
import { buildContextDecisionKnowledgePrior } from "../src/modules/context-decision/context-decision.knowledge-prior.js";
import type { ContextDecisionCandidateTrace } from "../src/modules/context-decision/context-decision.knowledge-assessment.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

function knowledge(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
    type: "rule",
    status: "active",
    scope: "repo",
    title: "Proceed with evidence",
    body: "Use evidence before asking.",
    confidence: 80,
    importance: 80,
    score: 0.4,
    appliesTo: {},
    metadata: {},
    sourceRefs: [],
    hasSourceLinks: false,
    dynamicScore: 0,
    compileSelectCount: 0,
    agenticAcceptCount: 0,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    decayFactor: 1,
    applicabilityScore: 0,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: false },
    ...overrides,
  };
}

function trace(
  overrides: Partial<ContextDecisionCandidateTrace> = {},
): ContextDecisionCandidateTrace {
  return {
    knowledgeId: "00000000-0000-0000-0000-000000000001",
    chunkId: null,
    role: "support",
    retrievalMethod: "keyword",
    vectorStatus: "unavailable",
    vectorSimilarity: null,
    keywordScore: 40,
    facetScore: 0,
    sourceQualityScore: 45,
    feedbackSignalScore: 50,
    finalCandidateScore: 60,
    selected: true,
    selectionReason: "top support candidate",
    rejectionReason: null,
    ...overrides,
  };
}

function corpusRow(overrides: Partial<CorpusKnowledgePriorRow> = {}): CorpusKnowledgePriorRow {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000101",
    type: "rule",
    status: "active",
    scope: "repo",
    title: "Prefer existing patterns",
    appliesTo: {
      technologies: ["typescript"],
      changeTypes: ["implementation"],
      domains: ["context-decision"],
    },
    confidence: 85,
    importance: 90,
    dynamicScore: 5,
    compileSelectCount: 2,
    agenticAcceptCount: 1,
    explicitUpvoteCount: 1,
    explicitDownvoteCount: 0,
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("context decision knowledge prior", () => {
  test("builds a reference-only prior from selected evidence", () => {
    const prior = buildContextDecisionKnowledgePrior({
      evidence: [{ knowledge: knowledge(), role: "selected_support" }],
      candidateTraces: [trace()],
    });

    expect(prior.status).toBe("available");
    expect(prior.referenceOnly).toBe(true);
    expect(prior.notUsedForScoring).toBe(true);
    expect(prior.signals.join("\n")).toContain("support");
  });

  test("does not pretend limited candidates are scoring evidence", () => {
    const prior = buildContextDecisionKnowledgePrior({
      evidence: [],
      candidateTraces: [trace({ selected: false })],
    });

    expect(prior.status).toBe("limited");
    expect(prior.notUsedForScoring).toBe(true);
    expect(prior.evidenceCount).toBe(0);
  });

  test("builds corpus prior as reference-only background from active knowledge", () => {
    const prior = buildCorpusKnowledgePriorFromRows(
      [
        corpusRow(),
        corpusRow({
          id: "00000000-0000-0000-0000-000000000102",
          type: "procedure",
          scope: "global",
          title: "Verify before final response",
          appliesTo: { technologies: ["typescript"], domains: ["verification"] },
        }),
      ],
      new Date("2026-06-10T01:00:00.000Z"),
    );

    expect(prior.source).toBe("corpus_prior_v1");
    expect(prior.referenceOnly).toBe(true);
    expect(prior.notUsedForScoring).toBe(true);
    expect(prior.activeKnowledgeCount).toBe(2);
    expect(prior.ruleCount).toBe(1);
    expect(prior.procedureCount).toBe(1);
    expect(prior.topTechnologies[0]).toBe("typescript (2)");
    expect(prior.signals.join("\n")).toContain("Prefer existing patterns");
  });

  test("loads a written corpus prior artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-decision-prior-"));
    const outputPath = join(dir, "knowledge-prior.json");
    const prior = buildCorpusKnowledgePriorFromRows([corpusRow()]);

    await writeCorpusKnowledgePrior(prior, outputPath);
    const loaded = await loadCorpusKnowledgePrior(outputPath);

    expect(loaded?.source).toBe("corpus_prior_v1");
    expect(loaded?.activeKnowledgeCount).toBe(1);
    expect(loaded?.referenceOnly).toBe(true);
  });
});
