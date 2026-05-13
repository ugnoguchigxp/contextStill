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
import { retrieveCodeContext } from "../code-index/code-index.service.js";
import { retrieveEvidence } from "../evidence/evidence.service.js";
import { retrieveKnowledge } from "../knowledge/knowledge.service.js";
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
  rules: 0.32,
  skills: 0.28,
  examples: 0.2,
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
    return "skill_context";
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

function scoreEvidenceOverlap(text: string, candidateText: string): number {
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

function formatEvidenceRef(sourceUri: string, locator: string): string {
  return `${sourceUri}#${locator}`;
}

function buildFallbackEvidenceRef(params: {
  runId: string;
  retrievalMode: RetrievalMode;
  degradedReasons: string[];
}): string {
  const reason =
    params.degradedReasons.find((item) => item.startsWith("NO_")) ??
    params.degradedReasons[0] ??
    "NO_EVIDENCE_MATCH";
  return `memory-router://packs/run/${params.runId}#${params.retrievalMode}:${reason}`;
}

function selectEvidenceRefsForKnowledge(
  item: { type: string; title: string; content: string },
  evidenceItems: Array<{ sourceUri: string; locator: string; content: string; score: number }>,
): string[] {
  if (evidenceItems.length === 0) return [];
  const scored = evidenceItems
    .map((evidenceItem) => {
      const overlap = scoreEvidenceOverlap(
        `${item.title}\n${item.content}`,
        `${evidenceItem.sourceUri}\n${evidenceItem.content}`,
      );
      return {
        ref: formatEvidenceRef(evidenceItem.sourceUri, evidenceItem.locator),
        score: evidenceItem.score + overlap * 0.05,
        overlap,
      };
    })
    .sort((a, b) => b.score - a.score);

  const overlapRefs = scored
    .filter((entry) => entry.overlap > 0)
    .slice(0, 2)
    .map((entry) => entry.ref);
  if (overlapRefs.length > 0) return [...new Set(overlapRefs)];

  const evidenceRequiredTypes = new Set(["fact", "decision", "risk", "lesson", "example"]);
  if (evidenceRequiredTypes.has(item.type)) {
    return [scored[0].ref];
  }
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
      `${item.title}\n${item.content}\n${item.rankingReason}\n${item.evidenceRefs.join("\n")}`,
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
        "Inspect active rules, risks, and relevant examples",
        "Check touched files against known constraints",
        "Verify evidence refs for each review claim",
        "Summarize findings with concrete next actions",
      ];
    case "debug_context":
      return [
        "Inspect failure-related evidence and code context first",
        "Narrow root cause candidates before editing",
        "Apply smallest fix aligned with known procedures",
        "Run targeted verification for the failing path",
      ];
    case "architecture_context":
      return [
        "Inspect prior decisions and architecture constraints",
        "Compare candidate design against known trade-offs",
        "List affected symbols/files and compatibility risks",
        "Propose implementation boundaries and validations",
      ];
    case "skill_context":
      return [
        "Inspect the selected procedure/skill candidates",
        "Execute only the necessary commands and checks",
        "Capture evidence refs for each operational claim",
        "Report result and follow-up verification steps",
      ];
    case "learning_context":
      return [
        "Review candidate/trial knowledge with evidence traceability",
        "Separate stable guidance from temporary observations",
        "Promote only verifiable items to stronger lifecycle states",
        "Record why each promotion/rejection decision was made",
      ];
    default:
      return [
        "Inspect relevant knowledge and evidence",
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
  evidenceRefs: string[];
}): ContextPackItem {
  const section =
    item.type === "skill" || item.type === "procedure"
      ? "skills"
      : item.type === "example"
        ? "examples"
        : "rules";
  return {
    id: `knowledge:${item.id}`,
    itemKind: item.type,
    itemId: item.id,
    section,
    title: item.title,
    content: item.body,
    score: item.score,
    rankingReason: "ranked by full-text/vector score with status filter",
    evidenceRefs: item.evidenceRefs,
  };
}

export async function compileContextPack(rawInput: unknown): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  const input = compileInputSchema.parse(rawInput);
  const retrievalMode = resolveRetrievalMode(input);
  const tokenBudget = input.tokenBudget ?? config.defaultTokenBudget;

  const [knowledge, evidence] = await Promise.all([
    retrieveKnowledge(input, { retrievalMode }),
    retrieveEvidence(input, { retrievalMode }),
  ]);
  const codeContext = await retrieveCodeContext(input, { retrievalMode });

  const degradedReasons = [
    ...knowledge.degradedReasons,
    ...evidence.degradedReasons,
    ...codeContext.degradedReasons,
  ];

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
      evidenceRefs: selectEvidenceRefsForKnowledge(
        { type: (item as { type: string }).type, title: item.title, content: item.content },
        evidence.items,
      ),
    }),
  );

  const budgetedRules = applySectionTokenBudget(
    packItems.filter((item) => item.section === "rules"),
    Math.floor(tokenBudget * sectionRatios.rules),
  );
  const budgetedSkills = applySectionTokenBudget(
    packItems.filter((item) => item.section === "skills"),
    Math.floor(tokenBudget * sectionRatios.skills),
  );
  const budgetedExamples = applySectionTokenBudget(
    packItems.filter((item) => item.section === "examples"),
    Math.floor(tokenBudget * sectionRatios.examples),
  );
  const budgetedCodeContext = applySectionTokenBudget(
    codeContext.items,
    Math.floor(tokenBudget * sectionRatios.codeContext),
  );

  const budgetDropDetected =
    budgetedRules.dropped ||
    budgetedSkills.dropped ||
    budgetedExamples.dropped ||
    budgetedCodeContext.dropped;
  if (budgetDropDetected) {
    degradedReasons.push("TOKEN_BUDGET_SECTION_LIMIT_REACHED");
  }

  const selectedPackItems = [
    ...budgetedRules.items,
    ...budgetedSkills.items,
    ...budgetedExamples.items,
    ...budgetedCodeContext.items,
  ];
  const itemEvidenceRefs = selectedPackItems.flatMap((item) => item.evidenceRefs);
  const evidenceRefsCandidate = [
    ...new Set([
      ...itemEvidenceRefs,
      ...evidence.items.map((item) => formatEvidenceRef(item.sourceUri, item.locator)),
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
      evidenceRefs: item.evidenceRefs,
    })),
  );

  const evidenceRefs =
    evidenceRefsCandidate.length > 0
      ? evidenceRefsCandidate
      : [buildFallbackEvidenceRef({ runId, retrievalMode, degradedReasons })];

  const pack = contextPackSchema.parse({
    runId,
    goal: input.goal,
    intent: input.intent,
    retrievalMode,
    status,
    minimalTasks,
    rules: budgetedRules.items,
    skills: budgetedSkills.items,
    examples: budgetedExamples.items,
    codeContext: budgetedCodeContext.items,
    warnings: [
      "Do not promote candidate/draft knowledge into instructions automatically.",
      "Keep evidence refs attached to factual claims.",
      ...(budgetDropDetected ? ["Token budget section caps trimmed lower-ranked items."] : []),
      ...(codeContext.items.length === 0
        ? ["No code symbol context found; compile used only knowledge/evidence layers."]
        : []),
    ],
    evidenceRefs,
    diagnostics: {
      degradedReasons,
      retrievalStats: {
        knowledge: knowledge.stats,
        evidence: evidence.stats,
        codeContext: codeContext.stats,
        tokenBudget,
      },
    },
  });

  const markdown = renderContextPackMarkdown(pack);
  return { pack, markdown };
}
