import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type { ContextDecisionKnowledgePrior } from "../../shared/schemas/context-decision.schema.js";

export const DEFAULT_CONTEXT_DECISION_CORPUS_PRIOR_PATH = resolve(
  "artifacts/context-decision/knowledge-prior.json",
);

export type CorpusKnowledgePriorArtifact = ContextDecisionKnowledgePrior & {
  schemaVersion: 1;
  generatedAt: string;
  totalKnowledgeCount: number;
  activeKnowledgeCount: number;
  ruleCount: number;
  procedureCount: number;
  repoScopedCount: number;
  globalScopedCount: number;
  topTechnologies: string[];
  topChangeTypes: string[];
  topDomains: string[];
};

export type CorpusKnowledgePriorRow = {
  id: string;
  type: string;
  status: string;
  scope: string;
  title: string;
  appliesTo: unknown;
  confidence: number;
  importance: number;
  dynamicScore: number;
  compileSelectCount: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  updatedAt: Date;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function incrementCounts(counts: Map<string, number>, values: string[]) {
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
}

function topKeys(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key} (${count})`);
}

function priorityScore(row: CorpusKnowledgePriorRow): number {
  const confidence = normalizeKnowledgeScore(row.confidence, 70);
  const importance = normalizeKnowledgeScore(row.importance, 70);
  return (
    importance * 0.45 +
    confidence * 0.35 +
    Math.max(0, Number(row.dynamicScore) || 0) * 0.1 +
    Math.max(0, Number(row.compileSelectCount) || 0) * 2 +
    Math.max(0, Number(row.agenticAcceptCount) || 0) * 2 +
    Math.max(0, Number(row.explicitUpvoteCount) || 0) * 2 -
    Math.max(0, Number(row.explicitDownvoteCount) || 0) * 4
  );
}

function topSignals(rows: CorpusKnowledgePriorRow[], limit: number): string[] {
  return [...rows]
    .sort(
      (a, b) =>
        priorityScore(b) - priorityScore(a) || b.updatedAt.getTime() - a.updatedAt.getTime(),
    )
    .slice(0, limit)
    .map((row) => {
      const kind = row.type === "procedure" ? "procedure" : "rule";
      return `${kind}: ${row.title}`;
    });
}

function validateArtifact(value: unknown): CorpusKnowledgePriorArtifact | null {
  const record = asRecord(value);
  if (record.schemaVersion !== 1) return null;
  if (record.source !== "corpus_prior_v1") return null;
  if (record.referenceOnly !== true || record.notUsedForScoring !== true) return null;
  const status =
    record.status === "available" || record.status === "limited" || record.status === "unavailable"
      ? record.status
      : "unavailable";
  const numberValue = (key: string) => {
    const raw = record[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };
  return {
    schemaVersion: 1,
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : "",
    status,
    source: "corpus_prior_v1",
    referenceOnly: true,
    notUsedForScoring: true,
    evidenceCount: numberValue("evidenceCount"),
    candidateCount: numberValue("candidateCount"),
    summary: typeof record.summary === "string" ? record.summary : "-",
    signals: asStringArray(record.signals),
    cautions: asStringArray(record.cautions),
    totalKnowledgeCount: numberValue("totalKnowledgeCount"),
    activeKnowledgeCount: numberValue("activeKnowledgeCount"),
    ruleCount: numberValue("ruleCount"),
    procedureCount: numberValue("procedureCount"),
    repoScopedCount: numberValue("repoScopedCount"),
    globalScopedCount: numberValue("globalScopedCount"),
    topTechnologies: asStringArray(record.topTechnologies),
    topChangeTypes: asStringArray(record.topChangeTypes),
    topDomains: asStringArray(record.topDomains),
  };
}

export function buildCorpusKnowledgePriorFromRows(
  rows: CorpusKnowledgePriorRow[],
  generatedAt = new Date(),
): CorpusKnowledgePriorArtifact {
  const activeRows = rows.filter((row) => row.status === "active");
  const technologyCounts = new Map<string, number>();
  const changeTypeCounts = new Map<string, number>();
  const domainCounts = new Map<string, number>();

  for (const row of activeRows) {
    const appliesTo = asRecord(row.appliesTo);
    incrementCounts(technologyCounts, asStringArray(appliesTo.technologies));
    incrementCounts(changeTypeCounts, asStringArray(appliesTo.changeTypes));
    incrementCounts(domainCounts, asStringArray(appliesTo.domains));
  }

  const ruleCount = activeRows.filter((row) => row.type === "rule").length;
  const procedureCount = activeRows.filter((row) => row.type === "procedure").length;
  const repoScopedCount = activeRows.filter((row) => row.scope === "repo").length;
  const globalScopedCount = activeRows.filter((row) => row.scope === "global").length;
  const status: ContextDecisionKnowledgePrior["status"] =
    activeRows.length > 0 ? "available" : rows.length > 0 ? "limited" : "unavailable";
  const signals = topSignals(activeRows, 8);
  const cautions =
    activeRows.length > 0
      ? [
          "Corpus prior is a background tendency only; retrieval evidence and deterministic scoring remain authoritative.",
          "Low-frequency or newly added Knowledge may be underrepresented until this artifact is regenerated.",
        ]
      : ["No active Knowledge was available when this corpus prior was generated."];

  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    status,
    source: "corpus_prior_v1",
    referenceOnly: true,
    notUsedForScoring: true,
    evidenceCount: activeRows.length,
    candidateCount: rows.length,
    summary:
      status === "available"
        ? `Corpus Knowledge Prior summarizes ${activeRows.length} active Knowledge items as background reference material.`
        : status === "limited"
          ? "Corpus Knowledge Prior found Knowledge rows but no active Knowledge items."
          : "Corpus Knowledge Prior is unavailable because no Knowledge rows were found.",
    signals,
    cautions,
    totalKnowledgeCount: rows.length,
    activeKnowledgeCount: activeRows.length,
    ruleCount,
    procedureCount,
    repoScopedCount,
    globalScopedCount,
    topTechnologies: topKeys(technologyCounts, 8),
    topChangeTypes: topKeys(changeTypeCounts, 8),
    topDomains: topKeys(domainCounts, 8),
  };
}

export async function buildCorpusKnowledgePriorFromDb(
  params: {
    limit?: number;
  } = {},
): Promise<CorpusKnowledgePriorArtifact> {
  const query = getDb()
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      scope: knowledgeItems.scope,
      title: knowledgeItems.title,
      appliesTo: knowledgeItems.appliesTo,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      dynamicScore: knowledgeItems.dynamicScore,
      compileSelectCount: knowledgeItems.compileSelectCount,
      agenticAcceptCount: knowledgeItems.agenticAcceptCount,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      updatedAt: knowledgeItems.updatedAt,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.status, "active"))
    .orderBy(desc(knowledgeItems.updatedAt));
  const rows = params.limit !== undefined ? await query.limit(params.limit) : await query;
  return buildCorpusKnowledgePriorFromRows(rows);
}

export async function writeCorpusKnowledgePrior(
  prior: CorpusKnowledgePriorArtifact,
  outputPath = DEFAULT_CONTEXT_DECISION_CORPUS_PRIOR_PATH,
): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(prior, null, 2)}\n`, "utf8");
  return outputPath;
}

export async function loadCorpusKnowledgePrior(
  inputPath = DEFAULT_CONTEXT_DECISION_CORPUS_PRIOR_PATH,
): Promise<CorpusKnowledgePriorArtifact | null> {
  try {
    const content = await readFile(inputPath, "utf8");
    return validateArtifact(JSON.parse(content));
  } catch {
    return null;
  }
}
