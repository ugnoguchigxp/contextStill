import { groupedConfig } from "../../config.js";
import type { CompileRunSource } from "../../shared/schemas/compile-run.schema.js";
import {
  type CompileInput,
  type RetrievalMode,
  compileInputSchema,
  deriveRetrievalModeFromChangeTypes,
} from "../../shared/schemas/compile.schema.js";
import {
  type ContextPack,
  type ContextPackItem,
  contextPackSchema,
} from "../../shared/schemas/context-pack.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { normalizeKnowledgeApplicability } from "../knowledge/applicability.service.js";
import { recordKnowledgeCompileSelectionSafe } from "../knowledge/knowledge-value.service.js";
import {
  type KnowledgeCandidateEvidence,
  retrieveKnowledge,
} from "../knowledge/knowledge.service.js";
import { retrieveSources } from "../sources/source-retrieval.service.js";
import { agenticRefine } from "./agentic-refine.service.js";
import {
  insertCompileRun,
  insertContextPackItems,
  updateCompileRunSnapshot,
} from "./context-compiler.repository.js";
import { composeContextResponse } from "./context-response-composer.service.js";
import { renderContextPackMarkdown } from "./pack-renderer.js";
import { type Rankable, rankAndDedupe } from "./ranking.service.js";
import { applySectionTokenBudget, estimateTokens } from "./token-budget.js";

const sectionRatios = {
  rules: 0.55,
  procedures: 0.45,
} as const;

const maintenanceReasonSet = new Set([
  "KNOWLEDGE_APPLIES_TO_FALLBACK",
  "TOKEN_BUDGET_SECTION_LIMIT_REACHED",
]);
const vectorOnlyScoreFloor = 0.52;
const designDocumentPathPattern =
  /(?:^|[\s"'`(（])(?:file:\/\/\/[^\s"'`）)]+|(?:\.{1,2}\/)?(?:docs?|design|specs?|requirements?|roadmap|proposal|architecture)\/[^\s"'`）)]+)\.(?:md|mdx)(?=$|[\s"'`）).,])/i;
const designDocumentFileNamePattern =
  /(?:^|[\s"'`(（])(?:design|spec|api-spec|requirements?|roadmap|proposal|architecture(?:-plan)?|plan|設計|仕様|要件)[\w.\-]*(?:\.md|\.mdx)(?=$|[\s"'`）).,])/iu;

function scoreSourceOverlap(text: string, candidateText: string): number {
  const baseTokens = text
    .toLowerCase()
    .split(/[^a-z0-9_\u3040-\u30ff\u4e00-\u9fff\uff61-\uff9f]+/g)
    .filter((token) => token.length >= 3)
    .slice(0, 32);
  if (baseTokens.length === 0) return 0;
  const candidate = candidateText.toLowerCase();
  let overlap = 0;
  for (const token of baseTokens) {
    if (candidate.includes(token)) overlap += 1;
  }
  return overlap;
}

function formatSourceRef(sourceUri: string, locator: string): string {
  return `${sourceUri}#${locator}`;
}

function buildFallbackSourceRef(params: {
  runId: string;
  retrievalMode: RetrievalMode;
  degradedReasons: string[];
}): string {
  const reason =
    params.degradedReasons.find((item) => item.startsWith("NO_")) ??
    params.degradedReasons[0] ??
    "NO_SOURCE_MATCH";
  return `memory-router://packs/run/${params.runId}#${params.retrievalMode}:${reason}`;
}

function selectSourceRefsForKnowledge(
  item: { title: string; content: string },
  sourceItems: Array<{ sourceUri: string; locator: string; content: string; score: number }>,
  knownSourceRefs: string[],
): string[] {
  if (knownSourceRefs.length > 0) {
    return [...new Set(knownSourceRefs)].slice(0, 4);
  }
  if (sourceItems.length === 0) return [];
  const scored = sourceItems
    .map((sourceItem) => {
      const overlap = scoreSourceOverlap(
        `${item.title}\n${item.content}`,
        `${sourceItem.sourceUri}\n${sourceItem.content}`,
      );
      return {
        ref: formatSourceRef(sourceItem.sourceUri, sourceItem.locator),
        score: sourceItem.score + overlap * 0.05,
        overlap,
      };
    })
    .sort((a, b) => b.score - a.score);

  const overlapRefs = scored
    .filter((entry) => entry.overlap > 0)
    .slice(0, 2)
    .map((entry) => entry.ref);
  if (overlapRefs.length > 0) return [...new Set(overlapRefs)];
  return [];
}

function buildMinimalTasks(retrievalMode: RetrievalMode): string[] {
  switch (retrievalMode) {
    case "review_context":
      return [
        "有効なルールと手順を確認する",
        "変更内容が既知の制約に反しないか検証する",
        "指摘は根拠を明確にして優先順位順にまとめる",
      ];
    case "debug_context":
      return [
        "関連する既知手順を先に確認する",
        "原因候補を狭めてから最小変更で修正する",
        "修正箇所に絞った再現・検証を行う",
      ];
    case "architecture_context":
      return [
        "既存ルールと制約を先に確認する",
        "設計候補のトレードオフを比較する",
        "実装境界と検証方法を明確化する",
      ];
    case "procedure_context":
      return [
        "手順候補を上から順に確認する",
        "必要最小限のコマンドのみ実行する",
        "結果と次の検証ステップを記録する",
      ];
    default:
      return ["関連する知識を確認する", "安全な最小変更で実装する", "変更箇所を重点検証する"];
  }
}

function normalizeKnowledgeType(value: string): KnowledgeItem["type"] {
  return value === "procedure" ? "procedure" : "rule";
}

function normalizeKnowledgeStatus(value: string): KnowledgeStatus {
  if (value === "deprecated") return "deprecated";
  if (value === "draft") return "draft";
  return "active";
}

function toKnowledgePackItem(item: {
  id: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  title: string;
  content: string;
  score: number;
  sourceRefs: string[];
}): ContextPackItem {
  const section = item.type === "procedure" ? "procedures" : "rules";
  return {
    id: `knowledge:${item.id}`,
    itemKind: item.type,
    itemId: item.id,
    section,
    title: item.title,
    content: item.content,
    score: item.score,
    rankingReason: `ranked by weighted score (${item.status})`,
    sourceRefs: item.sourceRefs,
  };
}

type KnowledgeRankable = Rankable & {
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  sourceRefs: string[];
  candidateEvidence?: KnowledgeCandidateEvidence;
};

type CompileReasonBuckets = {
  blockingReasons: string[];
  hardFailureReasons: string[];
  maintenanceWarnings: string[];
};

type InputFacetSummary = {
  requested: {
    changeTypes: string[];
    technologies: string[];
    domains: string[];
  };
  matched: {
    changeTypes: string[];
    technologies: string[];
    domains: string[];
  };
  unknown: {
    change_type: string[];
    technology: string[];
    domain: string[];
  };
};

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

function classifyCompileReasons(params: {
  reasons: string[];
  selectedKnowledgeCount: number;
}): CompileReasonBuckets {
  const uniqueReasons = [...new Set(params.reasons.map((reason) => reason.trim()).filter(Boolean))];
  const blockingReasons: string[] = [];
  const hardFailureReasons: string[] = [];
  const maintenanceWarnings: string[] = [];
  const hasKnowledge = params.selectedKnowledgeCount > 0;

  for (const reason of uniqueReasons) {
    if (maintenanceReasonSet.has(reason)) {
      maintenanceWarnings.push(reason);
      continue;
    }
    if (reason === "NO_ACTIVE_KNOWLEDGE_MATCH") {
      if (!hasKnowledge) blockingReasons.push(reason);
      continue;
    }
    if (reason.endsWith("_FAILED") || reason.includes("ERROR")) {
      hardFailureReasons.push(reason);
      blockingReasons.push(reason);
      continue;
    }
    blockingReasons.push(reason);
  }

  return {
    blockingReasons,
    hardFailureReasons,
    maintenanceWarnings,
  };
}

function goalContainsDesignDocumentReference(goal: string): boolean {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) return false;
  return (
    designDocumentPathPattern.test(trimmedGoal) || designDocumentFileNamePattern.test(trimmedGoal)
  );
}

function isLowConfidenceVectorOnlyCandidate(evidence?: KnowledgeCandidateEvidence): boolean {
  if (!evidence?.vectorMatched) return false;
  if (evidence.textMatched || evidence.facetMatched) return false;
  const score = typeof evidence.vectorScore === "number" ? evidence.vectorScore : 0;
  return score < vectorOnlyScoreFloor;
}

function filterByCandidateEvidence(items: KnowledgeRankable[]): {
  items: KnowledgeRankable[];
  suppressedCount: number;
} {
  const selected = items.filter(
    (item) => !isLowConfidenceVectorOnlyCandidate(item.candidateEvidence),
  );
  return {
    items: selected,
    suppressedCount: Math.max(0, items.length - selected.length),
  };
}

function buildInputFacets(params: {
  input: CompileInput;
  matchedChangeTypes: string[];
  matchedTechnologies: string[];
  matchedDomains: string[];
  unknownFacetsByKind: Record<string, string[]>;
}): InputFacetSummary {
  return {
    requested: {
      changeTypes: params.input.changeTypes ?? [],
      technologies: params.input.technologies ?? [],
      domains: params.input.domains ?? [],
    },
    matched: {
      changeTypes: params.matchedChangeTypes,
      technologies: params.matchedTechnologies,
      domains: params.matchedDomains,
    },
    unknown: {
      change_type: params.unknownFacetsByKind.change_type ?? [],
      technology: params.unknownFacetsByKind.technology ?? [],
      domain: params.unknownFacetsByKind.domain ?? [],
    },
  };
}

function updateCompileRunSnapshotSafe(runId: string, pack: ContextPack): Promise<void> {
  return updateCompileRunSnapshot(runId, pack).catch(() => undefined);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function attachOutputMarkdownToPack(pack: ContextPack, markdown: string): ContextPack {
  const retrievalStats = asRecord(pack.diagnostics.retrievalStats);
  const responseComposer = asRecord(retrievalStats.responseComposer);
  return {
    ...pack,
    diagnostics: {
      ...pack.diagnostics,
      retrievalStats: {
        ...retrievalStats,
        responseComposer: {
          ...responseComposer,
          outputMarkdown: markdown,
        },
      },
    },
  };
}

function legacyIntentFromRetrievalMode(retrievalMode: RetrievalMode): string {
  if (retrievalMode === "debug_context") return "debug";
  if (retrievalMode === "review_context") return "review";
  if (retrievalMode === "architecture_context") return "plan";
  if (retrievalMode === "procedure_context") return "edit";
  if (retrievalMode === "learning_context") return "finish";
  return "edit";
}

export async function compileContextPack(
  rawInput: unknown,
  options?: { source?: CompileRunSource },
): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  const compileStartedAt = Date.now();
  const input = compileInputSchema.parse(rawInput);
  const retrievalMode = deriveRetrievalModeFromChangeTypes(input.changeTypes);
  const tokenBudget = groupedConfig.compile.defaultTokenBudget;

  const normalizedApplicability = await normalizeKnowledgeApplicability({
    technologies: input.technologies,
    changeTypes: input.changeTypes,
    domains: input.domains,
  });

  const matchedTechnologies = asStringArray(normalizedApplicability.appliesTo.technologies);
  const matchedChangeTypes = asStringArray(normalizedApplicability.appliesTo.changeTypes);
  const matchedDomains = asStringArray(normalizedApplicability.appliesTo.domains);
  const unknownFacetsByKind = normalizedApplicability.unknownTagCandidates.reduce<
    Record<string, string[]>
  >((acc, candidate) => {
    const current = acc[candidate.kind] ?? [];
    if (!current.includes(candidate.value)) current.push(candidate.value);
    acc[candidate.kind] = current;
    return acc;
  }, {});

  const inputFacets = buildInputFacets({
    input,
    matchedChangeTypes,
    matchedTechnologies,
    matchedDomains,
    unknownFacetsByKind,
  });

  if (goalContainsDesignDocumentReference(input.goal)) {
    const degradedReasons = ["GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE"];
    const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);
    const reasonBuckets = classifyCompileReasons({
      reasons: degradedReasons,
      selectedKnowledgeCount: 0,
    });
    const runId = await insertCompileRun({
      goal: input.goal,
      intent: legacyIntentFromRetrievalMode(retrievalMode),
      input: {
        goal: input.goal,
        ...(input.changeTypes ? { changeTypes: input.changeTypes } : {}),
        ...(input.technologies ? { technologies: input.technologies } : {}),
        ...(input.domains ? { domains: input.domains } : {}),
      },
      retrievalMode,
      status: "degraded",
      degradedReasons,
      tokenBudget,
      durationMs: compileDurationMs,
      source: options?.source ?? "unknown",
    });

    const pack = contextPackSchema.parse({
      runId,
      goal: input.goal,
      retrievalMode,
      status: "degraded",
      minimalTasks: buildMinimalTasks(retrievalMode),
      rules: [],
      procedures: [],
      warnings: [],
      sourceRefs: [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })],
      diagnostics: {
        degradedReasons,
        retrievalStats: {
          knowledge: { skipped: true, reason: "goal_design_document_reference" },
          sources: { skipped: true, reason: "goal_design_document_reference" },
          tokenBudget,
          compileDurationMs,
          agenticUsed: false,
          reasonBuckets: {
            blocking: reasonBuckets.blockingReasons,
            maintenanceWarnings: reasonBuckets.maintenanceWarnings,
            hardFailures: reasonBuckets.hardFailureReasons,
          },
          suggestedNextCalls: [],
        },
        inputFacets,
      },
    });

    const markdown = renderContextPackMarkdown(pack);
    const packWithMarkdown = attachOutputMarkdownToPack(pack, markdown);
    await updateCompileRunSnapshotSafe(runId, packWithMarkdown);
    await recordKnowledgeCompileSelectionSafe({
      runId,
      selectedKnowledgeIds: [],
      agenticAcceptedKnowledgeIds: [],
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.contextCompileRun,
      actor: "agent",
      payload: {
        runId,
        goal: input.goal,
        retrievalMode,
        status: "degraded",
        degradedReasons,
        tokenBudget,
        compileDurationMs,
        source: options?.source ?? "unknown",
        selectedCounts: { rules: 0, procedures: 0 },
      },
    });

    return { pack: packWithMarkdown, markdown };
  }

  const [knowledge, sourceContext] = await Promise.all([
    retrieveKnowledge(input, {
      retrievalMode,
      facetFilters: {
        technologies: matchedTechnologies,
        changeTypes: matchedChangeTypes,
        domains: matchedDomains,
      },
    }),
    retrieveSources(input, { retrievalMode }),
  ]);

  const degradedReasons = [...knowledge.degradedReasons, ...sourceContext.degradedReasons];

  const rankedKnowledge = rankAndDedupe<KnowledgeRankable>(
    knowledge.items.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.body,
      score: item.score,
      confidence: item.confidence,
      importance: item.importance,
      dynamicScore: item.dynamicScore,
      decayFactor: item.decayFactor,
      type: normalizeKnowledgeType(item.type),
      status: normalizeKnowledgeStatus(item.status),
      sourceRefs: item.sourceRefs,
      sourceRefCount: item.sourceRefs.length,
      hasSourceLinks: item.hasSourceLinks,
      stale: item.status === "deprecated",
      applicabilityScore: item.applicabilityScore,
      candidateEvidence: item.candidateEvidence,
    })),
    15,
  );

  const knowledgeFilterResult = filterByCandidateEvidence(rankedKnowledge);
  const filteredKnowledge = knowledgeFilterResult.items;
  if (knowledgeFilterResult.suppressedCount > 0) {
    pushUnique(degradedReasons, "LOW_CONFIDENCE_VECTOR_ONLY_SUPPRESSED");
  }
  if (rankedKnowledge.length > 0 && filteredKnowledge.length === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }

  const agenticResult = await agenticRefine(
    filteredKnowledge.map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      content: item.content,
      score: item.score,
      sourceRefs: item.sourceRefs,
    })),
    input,
    retrievalMode,
  );

  if (agenticResult.error) pushUnique(degradedReasons, "AGENTIC_REFINE_FAILED");

  const refinedKnowledgeMap = new Map(filteredKnowledge.map((k) => [k.id, k]));
  const finalKnowledge = agenticResult.items
    .map((item) => refinedKnowledgeMap.get(item.id))
    .filter((k): k is KnowledgeRankable => k !== undefined);
  if (finalKnowledge.length === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }

  const packItems = finalKnowledge.map((item) => {
    const sourceRefs = selectSourceRefsForKnowledge(
      { title: item.title, content: item.content },
      sourceContext.items,
      item.sourceRefs,
    );
    return toKnowledgePackItem({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      content: item.content,
      score: item.score,
      sourceRefs,
    });
  });

  const budgetedRules = applySectionTokenBudget(
    packItems.filter((item) => item.section === "rules"),
    Math.floor(tokenBudget * sectionRatios.rules),
  );
  const budgetedProcedures = applySectionTokenBudget(
    packItems.filter((item) => item.section === "procedures"),
    Math.floor(tokenBudget * sectionRatios.procedures),
  );

  if (budgetedRules.dropped || budgetedProcedures.dropped) {
    pushUnique(degradedReasons, "TOKEN_BUDGET_SECTION_LIMIT_REACHED");
  }

  const selectedPackItems = [...budgetedRules.items, ...budgetedProcedures.items];
  const selectedKnowledgeCount = selectedPackItems.length;
  if (selectedKnowledgeCount === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }
  const composedResponse = await composeContextResponse({
    input,
    retrievalMode,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
  });
  if (composedResponse.error) {
    pushUnique(degradedReasons, "CONTEXT_RESPONSE_COMPOSE_FAILED");
  }
  if (composedResponse.markdown === "No Content" && selectedKnowledgeCount > 0) {
    pushUnique(degradedReasons, "COMPOSED_CONTEXT_NO_ALIGNMENT");
  }
  const sourceRefsCandidate = [
    ...new Set([
      ...selectedPackItems.flatMap((item) => item.sourceRefs),
      ...sourceContext.items.map((item) => formatSourceRef(item.sourceUri, item.locator)),
    ]),
  ];
  const reasonBuckets = classifyCompileReasons({
    reasons: degradedReasons,
    selectedKnowledgeCount,
  });
  const status =
    reasonBuckets.hardFailureReasons.length >= 2
      ? "failed"
      : reasonBuckets.blockingReasons.length > 0
        ? "degraded"
        : "ok";
  const minimalTasks = buildMinimalTasks(retrievalMode);
  const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);
  const suggestedNextCalls: string[] = [];
  if (degradedReasons.includes("NO_ACTIVE_KNOWLEDGE_MATCH")) {
    suggestedNextCalls.push("search_knowledge");
  }
  if (degradedReasons.includes("NO_SOURCE_MATCH")) {
    suggestedNextCalls.push("memory_search");
  }
  if (
    degradedReasons.some(
      (reason) =>
        reason.endsWith("_FAILED") ||
        reason === "AGENTIC_REFINE_FAILED" ||
        reason === "QUERY_EMBEDDING_UNAVAILABLE" ||
        reason === "SOURCE_QUERY_EMBEDDING_UNAVAILABLE",
    )
  ) {
    suggestedNextCalls.push("doctor");
  }

  const runId = await insertCompileRun({
    goal: input.goal,
    intent: legacyIntentFromRetrievalMode(retrievalMode),
    input: {
      goal: input.goal,
      ...(input.changeTypes ? { changeTypes: input.changeTypes } : {}),
      ...(input.technologies ? { technologies: input.technologies } : {}),
      ...(input.domains ? { domains: input.domains } : {}),
    },
    retrievalMode,
    status,
    degradedReasons,
    tokenBudget,
    durationMs: compileDurationMs,
    source: options?.source ?? "unknown",
  });

  await insertContextPackItems(
    runId,
    selectedPackItems.map((item) => ({
      itemKind: item.itemKind,
      itemId: item.itemId,
      section: item.section,
      score: item.score,
      rankingReason: item.rankingReason,
      sourceRefs: item.sourceRefs,
    })),
  );

  const selectedKnowledgeIds = [
    ...new Set(
      selectedPackItems
        .filter((item) => item.itemKind === "rule" || item.itemKind === "procedure")
        .map((item) => item.itemId),
    ),
  ];
  const agenticAcceptedKnowledgeIds = agenticResult.agenticUsed
    ? [...new Set(finalKnowledge.map((item) => item.id))]
    : [];
  await recordKnowledgeCompileSelectionSafe({
    runId,
    selectedKnowledgeIds,
    agenticAcceptedKnowledgeIds,
  });

  const sourceRefs =
    sourceRefsCandidate.length > 0
      ? sourceRefsCandidate
      : [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })];

  const pack = contextPackSchema.parse({
    runId,
    goal: input.goal,
    retrievalMode,
    status,
    minimalTasks,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
    warnings: [],
    sourceRefs,
    diagnostics: {
      degradedReasons,
      retrievalStats: {
        knowledge: knowledge.stats,
        sources: sourceContext.stats,
        tokenBudget,
        compileDurationMs,
        agenticUsed: agenticResult.agenticUsed,
        agenticReasoning: agenticResult.reasoning,
        reasonBuckets: {
          blocking: reasonBuckets.blockingReasons,
          maintenanceWarnings: reasonBuckets.maintenanceWarnings,
          hardFailures: reasonBuckets.hardFailureReasons,
        },
        responseComposer: {
          used: composedResponse.agenticUsed,
          markdownKind: composedResponse.markdown === "No Content" ? "no-content" : "narrative",
          ...(composedResponse.error ? { error: composedResponse.error } : {}),
        },
        suggestedNextCalls: [...new Set(suggestedNextCalls)],
      },
      inputFacets,
    },
  });

  const markdown = composedResponse.markdown || renderContextPackMarkdown(pack);
  const packWithMarkdown = attachOutputMarkdownToPack(pack, markdown);

  await updateCompileRunSnapshotSafe(runId, packWithMarkdown);

  await recordAuditLogSafe({
    eventType: auditEventTypes.contextCompileRun,
    actor: "agent",
    payload: {
      runId,
      goal: input.goal,
      retrievalMode,
      status,
      degradedReasons,
      tokenBudget,
      compileDurationMs,
      source: options?.source ?? "unknown",
      selectedCounts: {
        rules: budgetedRules.items.length,
        procedures: budgetedProcedures.items.length,
      },
    },
  });

  return { pack: packWithMarkdown, markdown };
}
