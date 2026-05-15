import { config } from "../../config.js";
import {
  type CompileInput,
  type RetrievalMode,
  compileInputSchema,
} from "../../shared/schemas/compile.schema.js";
import {
  type ContextPack,
  type ContextPackItem,
  contextPackSchema,
} from "../../shared/schemas/context-pack.schema.js";
import { retrieveKnowledge } from "../knowledge/knowledge.service.js";
import { retrieveSources } from "../sources/source-retrieval.service.js";
import { insertCompileRun, insertContextPackItems } from "./context-compiler.repository.js";
import { renderContextPackMarkdown } from "./pack-renderer.js";
import { rankAndDedupe } from "./ranking.service.js";

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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateForBudget(content: string, maxTokens: number): string {
  const maxChars = Math.max(80, maxTokens * 4);
  if (content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(1, maxChars - 3))}...`;
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
): string[] {
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

function toKnowledgePackItem(item: {
  id: string;
  type: string;
  title: string;
  body: string;
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
    content: item.body,
    score: item.score,
    rankingReason: "ranked by full-text/vector score with status filter",
    sourceRefs: item.sourceRefs,
  };
}

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

export async function compileContextPack(rawInput: unknown): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  const input = compileInputSchema.parse(rawInput);
  const retrievalMode = resolveRetrievalMode(input);
  const tokenBudget = input.tokenBudget ?? config.defaultTokenBudget;

  const [knowledge, sourceContext] = await Promise.all([
    retrieveKnowledge(input, { retrievalMode }),
    retrieveSources(input, { retrievalMode }),
  ]);

  const degradedReasons = [...knowledge.degradedReasons, ...sourceContext.degradedReasons];

  const rankedKnowledge = rankAndDedupe(
    knowledge.items.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.body,
      score: item.score,
      confidence: item.confidence,
      importance: item.importance,
      type: item.type,
    })),
    10,
  );

  const packItems = rankedKnowledge.map((item) =>
    toKnowledgePackItem({
      id: item.id,
      type: (item as { type: string }).type,
      title: item.title,
      body: item.content,
      score: item.score,
      sourceRefs: selectSourceRefsForKnowledge(
        { type: (item as { type: string }).type, title: item.title, content: item.content },
        sourceContext.items,
      ),
    }),
  );

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

  const runId = await insertCompileRun({
    goal: input.goal,
    intent: input.intent,
    repoPath: input.repoPath,
    input: input as unknown as Record<string, unknown>,
    retrievalMode,
    status,
    degradedReasons,
    tokenBudget,
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
      ...(budgetDropDetected ? ["Token budget section caps trimmed lower-ranked items."] : []),
    ],
    sourceRefs,
    diagnostics: {
      degradedReasons,
      retrievalStats: {
        knowledge: knowledge.stats,
        sources: sourceContext.stats,
        tokenBudget,
      },
    },
  });

  const markdown = renderContextPackMarkdown(pack);
  return { pack, markdown };
}
