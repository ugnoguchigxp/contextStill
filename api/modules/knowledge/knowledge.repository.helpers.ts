import { type SQL, and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { knowledgeItems } from "../../../src/db/schema.js";
import {
  mergeApplicabilityInput,
  normalizeKnowledgeApplicability,
} from "../../../src/modules/knowledge/applicability.service.js";
import type { KnowledgeCreateInput, KnowledgeListParams } from "./knowledge.repository.types.js";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function extractSourceRefs(metadata: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const sourceRefs = Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs : [];
  const candidateSourceRefs = Array.isArray(metadata.candidateSourceRefs)
    ? metadata.candidateSourceRefs
    : [];
  for (const value of [...sourceRefs, ...candidateSourceRefs]) {
    if (typeof value === "string" && value.trim()) refs.add(value.trim());
  }

  const sourceDocumentUri =
    typeof metadata.sourceDocumentUri === "string" ? metadata.sourceDocumentUri.trim() : "";
  const sourceUri = typeof metadata.sourceUri === "string" ? metadata.sourceUri.trim() : "";
  const locator =
    typeof metadata.sourceFragmentLocator === "string" && metadata.sourceFragmentLocator.trim()
      ? metadata.sourceFragmentLocator.trim()
      : "full";
  const origin = sourceDocumentUri || sourceUri;
  if (origin) refs.add(`${origin}#${locator}`);
  return [...refs].slice(0, 8);
}

export function extractSourceVibeMemoryIds(metadata: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const direct = Array.isArray(metadata.sourceVibeMemoryIds) ? metadata.sourceVibeMemoryIds : [];
  for (const value of direct) {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
  }
  const sourceUri = typeof metadata.sourceUri === "string" ? metadata.sourceUri.trim() : "";
  if (sourceUri.startsWith("vibe-memory://")) {
    const id = sourceUri.replace("vibe-memory://", "").trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

export function isMissingKnowledgeLifecycleColumnsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code = (error as { code?: unknown })?.code;
  if (code === "42703") return true;
  return (
    normalized.includes("compile_select_count") ||
    normalized.includes("last_compiled_at") ||
    normalized.includes("agentic_accept_count") ||
    normalized.includes("explicit_upvote_count") ||
    normalized.includes("explicit_downvote_count") ||
    normalized.includes("dynamic_score")
  );
}

export function buildKnowledgeListWhere(
  params: Pick<KnowledgeListParams, "status" | "type" | "query" | "displayFilter" | "minQuality">,
) {
  const conditions: SQL[] = [];
  const displayFilter = params.displayFilter ?? "all";
  if (displayFilter === "draft" || displayFilter === "active" || displayFilter === "deprecated") {
    conditions.push(eq(knowledgeItems.status, displayFilter));
  } else if (params.status) {
    conditions.push(eq(knowledgeItems.status, params.status));
  }
  if (displayFilter === "unused-active") {
    conditions.push(eq(knowledgeItems.status, "active"));
    conditions.push(eq(knowledgeItems.compileSelectCount, 0));
  }
  if (displayFilter === "stale") {
    conditions.push(sql`
      exp(
        -(
          case when ${knowledgeItems.type} = 'procedure' then 0.004 else 0.001 end
        ) * (
          case when ${knowledgeItems.scope} = 'global' then 0.5 else 1 end
        ) * greatest(
          0,
          extract(
            epoch from (
              now() - coalesce(${knowledgeItems.lastVerifiedAt}, ${knowledgeItems.updatedAt})
            )
          ) / 86400.0
        )
      ) < 0.5
    `);
  }
  if (displayFilter === "high-value") {
    conditions.push(sql`${knowledgeItems.dynamicScore} >= 60`);
  }
  if (params.type) {
    conditions.push(eq(knowledgeItems.type, params.type));
  }
  if (params.query?.trim()) {
    const query = `%${params.query.trim()}%`;
    const searchCondition = or(
      ilike(knowledgeItems.title, query),
      ilike(knowledgeItems.body, query),
      sql`${knowledgeItems.appliesTo} ->> 'technologies' ilike ${query}`,
      sql`${knowledgeItems.appliesTo} ->> 'domains' ilike ${query}`,
      sql`${knowledgeItems.appliesTo} ->> 'changeTypes' ilike ${query}`,
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  if ((params.minQuality ?? 0) > 0) {
    conditions.push(
      sql`(${knowledgeItems.importance} * 0.6 + ${knowledgeItems.confidence} * 0.4) >= ${params.minQuality ?? 0}`,
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export function buildKnowledgeListOrderBy(params: Pick<KnowledgeListParams, "sortBy" | "sortDir">) {
  const sortBy = params.sortBy ?? "updatedAt";
  const direction = params.sortDir === "asc" ? asc : desc;
  const qualityScore = sql<number>`(${knowledgeItems.importance} * 0.6 + ${knowledgeItems.confidence} * 0.4)`;
  const sortableColumns = {
    title: sql`lower(${knowledgeItems.title})`,
    type: sql`${knowledgeItems.type}`,
    status: sql`${knowledgeItems.status}`,
    scope: sql`${knowledgeItems.scope}`,
    qualityScore,
    updatedAt: sql`${knowledgeItems.updatedAt}`,
  };
  const selected = sortableColumns[sortBy] ?? sortableColumns.updatedAt;
  return [direction(selected), desc(knowledgeItems.updatedAt), desc(knowledgeItems.id)];
}

type KnowledgeApplicabilityInput = Pick<
  KnowledgeCreateInput,
  "appliesTo" | "general" | "technologies" | "changeTypes" | "domains" | "repoPath" | "repoKey"
>;

const knownApplicabilityKeys = new Set([
  "general",
  "technologies",
  "changeTypes",
  "domains",
  "repoPath",
  "repoKey",
]);

export async function buildNormalizedApplicability(input: KnowledgeApplicabilityInput) {
  const mergedInput = mergeApplicabilityInput({
    appliesTo: input.appliesTo,
    general: input.general,
    technologies: input.technologies,
    changeTypes: input.changeTypes,
    domains: input.domains,
    repoPath: input.repoPath,
    repoKey: input.repoKey,
  });
  return normalizeKnowledgeApplicability(mergedInput);
}

function pickUnknownApplicabilityKeys(value: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!knownApplicabilityKeys.has(key)) {
      extras[key] = entry;
    }
  }
  return extras;
}

export function mergeNormalizedApplicability(params: {
  existingAppliesTo?: unknown;
  inputAppliesTo?: unknown;
  normalizedAppliesTo: Record<string, unknown>;
}): Record<string, unknown> {
  const existing = asRecord(params.existingAppliesTo);
  const incoming = asRecord(params.inputAppliesTo);
  return {
    ...pickUnknownApplicabilityKeys(existing),
    ...pickUnknownApplicabilityKeys(incoming),
    ...params.normalizedAppliesTo,
  };
}

export function mergeApplicabilityMetadata(
  metadata: Record<string, unknown>,
  normalized: Awaited<ReturnType<typeof buildNormalizedApplicability>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata };
  if (normalized.warnings.length > 0) {
    next.tagNormalizationWarnings = normalized.warnings;
  }
  if (normalized.unknownTagCandidates.length > 0) {
    next.unknownTagCandidates = normalized.unknownTagCandidates;
  }
  return next;
}
