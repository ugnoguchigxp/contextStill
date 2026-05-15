import crypto from "node:crypto";
import { config } from "../../config.js";
import {
  type CompileInput,
  type CompileErrorKind,
  type RetrievalMode,
  compileInputSchema,
} from "../../shared/schemas/compile.schema.js";
import {
  type ContextPack,
  type ContextPackItem,
  contextPackSchema,
} from "../../shared/schemas/context-pack.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { normalizeRepoKey, normalizeRepoPath } from "./query-context.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { retrieveKnowledge } from "../knowledge/knowledge.service.js";
import { retrieveSources } from "../sources/source-retrieval.service.js";
import {
  getCompileFreshnessMarkers,
  insertCompileRun,
  insertContextPackItems,
} from "./context-compiler.repository.js";
import { renderContextPackMarkdown } from "./pack-renderer.js";
import { type Rankable, rankAndDedupe } from "./ranking.service.js";
import { agenticRefine } from "./agentic-refine.service.js";

const retrievalModeByIntent: Record<CompileInput["intent"], RetrievalMode> = {
  plan: "architecture_context",
  edit: "task_context",
  debug: "debug_context",
  review: "review_context",
  finish: "learning_context",
};

const sectionRatios = {
  rules: 0.45,
  procedures: 0.35,
  codeContext: 0.2,
} as const;

function resolveRetrievalMode(input: CompileInput): RetrievalMode {
  if (input.retrievalMode) return input.retrievalMode;
  const goal = input.goal.toLowerCase();
  if (
    goal.includes("runbook") ||
    goal.includes("playbook") ||
    goal.includes("procedure") ||
    goal.includes("command") ||
    goal.includes("手順") ||
    goal.includes("コマンド")
  ) {
    return "procedure_context";
  }
  return retrievalModeByIntent[input.intent];
}

function isWhitespaceCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x20 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function estimatedTokenWeight(char: string): number {
  const codePoint = char.codePointAt(0);
  if (!codePoint) return 0;
  if (isWhitespaceCodePoint(codePoint)) return 0.15;
  if (codePoint <= 0x7f) return 0.25;
  if (isCjkCodePoint(codePoint)) return 0.8;
  if (codePoint > 0xffff) return 1;
  return 0.5;
}

function estimateTokens(text: string): number {
  let total = 0;
  for (const char of text) {
    total += estimatedTokenWeight(char);
  }
  return Math.max(1, Math.ceil(total));
}

function truncateForBudget(content: string, maxTokens: number): string {
  if (!content.trim()) return content;
  if (maxTokens <= 0) return "...";
  if (estimateTokens(content) <= maxTokens) return content;
  const suffix = "...";
  const suffixTokens = estimateTokens(suffix);
  const maxContentTokens = Math.max(1, maxTokens - suffixTokens);
  const selectedChars: string[] = [];
  let usedTokens = 0;
  for (const char of content) {
    const tokenCost = estimatedTokenWeight(char);
    if (usedTokens + tokenCost > maxContentTokens) break;
    selectedChars.push(char);
    usedTokens += tokenCost;
  }
  if (selectedChars.length === 0) {
    return suffix;
  }
  while (
    selectedChars.length > 0 &&
    estimateTokens(`${selectedChars.join("")}${suffix}`) > maxTokens
  ) {
    selectedChars.pop();
  }
  if (selectedChars.length === 0) {
    return suffix;
  }
  return `${selectedChars.join("")}${suffix}`;
}

function scoreSourceOverlap(text: string, candidateText: string): number {
  const baseTokens = text
    .toLowerCase()
    .split(/[^a-z0-9_\u3040-\u30ff\u4e00-\u9faf]+/g)
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
  item: { type: string; title: string; content: string },
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

function applySectionTokenBudget(
  items: ContextPackItem[],
  maxTokens: number,
): { items: ContextPackItem[]; dropped: boolean } {
  if (items.length === 0 || maxTokens <= 0) {
    return { items: [], dropped: items.length > 0 };
  }
  const selected: ContextPackItem[] = [];
  let usedTokens = 0;
  for (const item of items) {
    const itemCost = estimateTokens(
      `${item.title}\n${item.content}\n${item.rankingReason}\n${item.sourceRefs.join("\n")}`,
    );
    if (usedTokens + itemCost <= maxTokens) {
      selected.push(item);
      usedTokens += itemCost;
      continue;
    }
    if (selected.length === 0) {
      const remaining = Math.max(24, maxTokens - usedTokens);
      const truncatedContent = truncateForBudget(item.content, remaining);
      selected.push({ ...item, content: truncatedContent });
    }
    break;
  }
  return { items: selected, dropped: selected.length < items.length };
}

function buildMinimalTasks(retrievalMode: RetrievalMode): string[] {
  switch (retrievalMode) {
    case "review_context":
      return [
        "Inspect active rules, procedures, and relevant source material",
        "Check touched files against known constraints",
        "Verify source refs for each review claim",
        "Summarize findings with concrete next actions",
      ];
    case "debug_context":
      return [
        "Inspect failure-related source material and code context first",
        "Narrow root cause candidates before editing",
        "Apply smallest fix aligned with known procedures",
        "Run targeted verification for the failing path",
      ];
    case "architecture_context":
      return [
        "Inspect prior rules and architecture constraints",
        "Compare candidate design against known trade-offs",
        "List affected symbols/files and compatibility risks",
        "Propose implementation boundaries and validations",
      ];
    case "procedure_context":
      return [
        "Inspect the selected procedure candidates",
        "Execute only the necessary commands and checks",
        "Capture source refs for each operational claim",
        "Report result and follow-up verification steps",
      ];
    case "learning_context":
      return [
        "Review draft knowledge with source traceability",
        "Separate stable guidance from temporary observations",
        "Promote only verifiable items to active state",
        "Record why each promotion or deprecation decision was made",
      ];
    default:
      return [
        "Inspect relevant knowledge and source material",
        "Apply active rules and procedures only",
        "Implement smallest safe change set",
        "Run focused verification for touched behavior",
      ];
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
};

function buildCodeContextItems(files: string[] | undefined): ContextPackItem[] {
  const uniqueFiles = [...new Set((files ?? []).map((file) => file.trim()).filter(Boolean))];
  return uniqueFiles.map((filePath, index) => ({
    id: `file_hint:${filePath}`,
    itemKind: "file_hint",
    itemId: filePath,
    section: "code_context",
    title: filePath,
    content: filePath,
    score: Math.max(0.1, 1 - index * 0.05),
    rankingReason: "provided in compile input files",
    sourceRefs: [],
  }));
}

type CompileErrorSignals = {
  kind?: CompileErrorKind;
  keywords: string[];
  files: string[];
};

type CompileCacheKeyDraft = {
  version: string;
  repoPath: string | null;
  repoKey: string | null;
  retrievalMode: RetrievalMode;
  tokenBudget: number;
  includeDraft: boolean;
  intent: CompileInput["intent"];
  taskType: CompileInput["intent"];
  goalHash: string;
  filesHash: string;
  changeTypesHash: string;
  technologiesHash: string;
  freshness: {
    knowledgeActiveUpdatedAt: string | null;
    knowledgeDraftUpdatedAt: string | null;
    sourceCorpusUpdatedAt: string | null;
  };
};

function hashValue(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeErrorText(value: string | undefined): string {
  return value ? value.trim().toLowerCase() : "";
}

function extractErrorKeywords(input: CompileInput): string[] {
  const rawTexts = [
    normalizeErrorText(input.lastErrorContext?.command),
    normalizeErrorText(input.lastErrorContext?.output),
    normalizeErrorText(input.lastErrorContext?.stack),
    input.errorKind ?? "",
  ];
  const stopWords = new Set([
    "error",
    "errors",
    "failed",
    "failure",
    "exception",
    "line",
    "column",
    "stack",
    "trace",
    "module",
    "file",
    "test",
    "tests",
    "lint",
    "typecheck",
    "build",
    "runtime",
    "unknown",
  ]);
  const keywords = new Set<string>();
  for (const text of rawTexts) {
    if (!text) continue;
    for (const token of text.split(/[^a-z0-9_\-./\u3040-\u30ff\u4e00-\u9faf]+/g)) {
      const normalized = token.trim();
      if (!normalized) continue;
      if (normalized.length < 3 && !/[\u3040-\u30ff\u4e00-\u9faf]/.test(normalized)) continue;
      if (stopWords.has(normalized)) continue;
      keywords.add(normalized);
      if (keywords.size >= 32) return [...keywords];
    }
  }
  return [...keywords];
}

function extractErrorFileHints(input: CompileInput): string[] {
  const candidates = [...(input.files ?? []), ...(input.lastErrorContext?.files ?? [])];
  const normalized = candidates
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/\\/g, "/").toLowerCase());
  return [...new Set(normalized)].slice(0, 24);
}

function buildCompileErrorSignals(input: CompileInput): CompileErrorSignals {
  return {
    kind: input.errorKind,
    keywords: extractErrorKeywords(input),
    files: extractErrorFileHints(input),
  };
}

function countMatches(haystack: string, needles: string[]): number {
  if (!haystack || needles.length === 0) return 0;
  let hits = 0;
  for (const needle of needles) {
    if (needle && haystack.includes(needle)) hits += 1;
  }
  return hits;
}

function buildCompileCacheKeyDraft(params: {
  input: CompileInput;
  retrievalMode: RetrievalMode;
  tokenBudget: number;
  repoPath?: string;
  repoKey?: string;
  freshness: {
    knowledgeActiveUpdatedAt: string | null;
    knowledgeDraftUpdatedAt: string | null;
    sourceCorpusUpdatedAt: string | null;
  };
}): CompileCacheKeyDraft {
  const normalizedFiles = [...new Set((params.input.files ?? []).map((item) => item.trim()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const changeTypes = [...new Set((params.input.changeTypes ?? []).map((item) => item.trim()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const technologies = [...new Set((params.input.technologies ?? []).map((item) => item.trim()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return {
    version: "v1-exact-normalized",
    repoPath: params.repoPath ?? null,
    repoKey: params.repoKey ?? null,
    retrievalMode: params.retrievalMode,
    tokenBudget: params.tokenBudget,
    includeDraft: params.input.includeDraft,
    intent: params.input.intent,
    taskType: params.input.intent,
    goalHash: hashValue(params.input.goal.trim()),
    filesHash: hashValue(normalizedFiles),
    changeTypesHash: hashValue(changeTypes),
    technologiesHash: hashValue(technologies),
    freshness: params.freshness,
  };
}

export async function compileContextPack(rawInput: unknown): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  const compileStartedAt = Date.now();
  const input = compileInputSchema.parse(rawInput);
  const retrievalMode = resolveRetrievalMode(input);
  const tokenBudget = input.tokenBudget ?? config.defaultTokenBudget;
  const normalizedRepoPath = normalizeRepoPath(input.repoPath);
  const normalizedRepoKey = normalizeRepoKey(input.repoPath);

  const [knowledge, sourceContext, freshnessMarkers] = await Promise.all([
    retrieveKnowledge(input, { retrievalMode }),
    retrieveSources(input, { retrievalMode }),
    getCompileFreshnessMarkers({
      repoPath: normalizedRepoPath,
      repoKey: normalizedRepoKey,
    }),
  ]);
  const cacheKeyDraft = buildCompileCacheKeyDraft({
    input,
    retrievalMode,
    tokenBudget,
    repoPath: normalizedRepoPath,
    repoKey: normalizedRepoKey,
    freshness: freshnessMarkers,
  });
  const errorSignals = buildCompileErrorSignals(input);

  const degradedReasons = [...knowledge.degradedReasons, ...sourceContext.degradedReasons];

  const rankedKnowledge = rankAndDedupe<KnowledgeRankable>(
    knowledge.items.map((item) => {
      const searchable = `${item.title}\n${item.body}\n${item.sourceRefs.join("\n")}`.toLowerCase();
      return {
        id: item.id,
        title: item.title,
        content: item.body,
        score: item.score,
        confidence: item.confidence,
        importance: item.importance,
        type: normalizeKnowledgeType(item.type),
        status: normalizeKnowledgeStatus(item.status),
        sourceRefs: item.sourceRefs,
        sourceRefCount: item.sourceRefs.length,
        hasSourceLinks: item.hasSourceLinks,
        stale: item.status === "deprecated",
        errorKeywordHits: countMatches(searchable, errorSignals.keywords),
        errorFileHits: countMatches(searchable, errorSignals.files),
        errorContextWeight: input.lastErrorContext ? 1 : 0,
      };
    }),
    15,
  );

  const agenticResult = await agenticRefine(
    rankedKnowledge.map((item) => ({
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

  if (agenticResult.error) {
    degradedReasons.push("AGENTIC_REFINE_FAILED");
  }

  const refinedKnowledgeMap = new Map(rankedKnowledge.map((k) => [k.id, k]));
  const finalKnowledge = agenticResult.items
    .map((item) => refinedKnowledgeMap.get(item.id))
    .filter((k): k is KnowledgeRankable => k !== undefined);

  const packItems = finalKnowledge.map((item) => {
    const sourceRefs = selectSourceRefsForKnowledge(
      { type: item.type, title: item.title, content: item.content },
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
  const budgetedCodeContext = applySectionTokenBudget(
    buildCodeContextItems(input.files),
    Math.floor(tokenBudget * sectionRatios.codeContext),
  );

  const budgetDropDetected =
    budgetedRules.dropped || budgetedProcedures.dropped || budgetedCodeContext.dropped;
  if (budgetDropDetected) {
    degradedReasons.push("TOKEN_BUDGET_SECTION_LIMIT_REACHED");
  }

  const selectedPackItems = [
    ...budgetedRules.items,
    ...budgetedProcedures.items,
    ...budgetedCodeContext.items,
  ];
  const itemSourceRefs = selectedPackItems.flatMap((item) => item.sourceRefs);
  const sourceRefsCandidate = [
    ...new Set([
      ...itemSourceRefs,
      ...sourceContext.items.map((item) => formatSourceRef(item.sourceUri, item.locator)),
    ]),
  ];
  const hardFailureCount = degradedReasons.filter((reason) => reason.endsWith("_FAILED")).length;
  const status = hardFailureCount >= 2 ? "failed" : degradedReasons.length > 0 ? "degraded" : "ok";
  const minimalTasks = buildMinimalTasks(retrievalMode);
  const selectedStatuses = new Set(rankedKnowledge.map((item) => item.status));
  const suggestedNextCalls: string[] = [];
  if (degradedReasons.includes("NO_ACTIVE_KNOWLEDGE_MATCH")) {
    suggestedNextCalls.push("search_knowledge");
    suggestedNextCalls.push("memory_search");
  }
  if (degradedReasons.includes("NO_SOURCE_MATCH")) {
    suggestedNextCalls.push("memory_search");
    suggestedNextCalls.push("bun run import:sources -- <wiki root>");
    suggestedNextCalls.push("bun run distill:sources -- --apply");
  }
  if (
    degradedReasons.includes("KNOWLEDGE_APPLIES_TO_FALLBACK") ||
    degradedReasons.includes("KNOWLEDGE_REPO_SCOPE_FALLBACK") ||
    degradedReasons.includes("SOURCE_REPO_SCOPE_FALLBACK")
  ) {
    suggestedNextCalls.push("context_compile (retry with explicit repoPath/files)");
  }
  if (
    degradedReasons.some(
      (r) =>
        r.endsWith("_FAILED") ||
        r.includes("UNAVAILABLE") ||
        r.includes("ERROR") ||
        r.includes("BUDGET_SECTION_LIMIT_REACHED"),
    )
  ) {
    suggestedNextCalls.push("doctor");
  }
  if (knowledge.stats.embeddingStatus === "unavailable") {
    suggestedNextCalls.push("doctor");
  }

  const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);

  const runId = await insertCompileRun({
    goal: input.goal,
    intent: input.intent,
    repoPath: normalizedRepoPath ?? input.repoPath,
    input: input as unknown as Record<string, unknown>,
    retrievalMode,
    status,
    degradedReasons,
    tokenBudget,
    durationMs: compileDurationMs,
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

  const sourceRefs =
    sourceRefsCandidate.length > 0
      ? sourceRefsCandidate
      : [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })];

  const pack = contextPackSchema.parse({
    runId,
    goal: input.goal,
    intent: input.intent,
    retrievalMode,
    status,
    minimalTasks,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
    codeContext: budgetedCodeContext.items,
    warnings: [
      "Do not promote draft knowledge into instructions automatically.",
      "Keep source refs attached when a rule or procedure depends on source material.",
      ...(selectedStatuses.has("draft")
        ? ["Draft knowledge is included; verify before turning it into stable instructions."]
        : []),
      ...(suggestedNextCalls.length > 0
        ? [`Suggested next MCP calls: ${[...new Set(suggestedNextCalls)].join(", ")}`]
        : []),
      ...(budgetDropDetected ? ["Token budget section caps trimmed lower-ranked items."] : []),
    ],
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
        cacheKeyDraft,
        errorContext: {
          errorKind: errorSignals.kind ?? null,
          keywordCount: errorSignals.keywords.length,
          fileHintCount: errorSignals.files.length,
        },
        suggestedNextCalls: [...new Set(suggestedNextCalls)],
      },
    },
  });

  await recordAuditLogSafe({
    eventType: auditEventTypes.contextCompileRun,
    actor: "agent",
    payload: {
      runId,
      goal: input.goal,
      intent: input.intent,
      retrievalMode,
      status,
      repoPath: normalizedRepoPath ?? null,
      repoKey: normalizedRepoKey ?? null,
      degradedReasons,
      tokenBudget,
      compileDurationMs,
      selectedCounts: {
        rules: budgetedRules.items.length,
        procedures: budgetedProcedures.items.length,
        codeContext: budgetedCodeContext.items.length,
      },
    },
  });

  const markdown = renderContextPackMarkdown(pack);
  return { pack, markdown };
}
