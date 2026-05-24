import type { DistillationTargetPriorityGroup } from "./domain.js";

const PRIORITY_GROUP_SET = new Set<DistillationTargetPriorityGroup>([
  "knowledge_candidate",
  "web_ingest",
  "wiki",
  "vibe_memory",
]);

const WIKI_HINT_GROUP_KEYS = [
  "priorityGroup",
  "priority_group",
  "parentPriorityGroup",
  "parent_priority_group",
] as const;

const WIKI_HINT_KIND_KEYS = [
  "parentTargetKind",
  "parent_target_kind",
  "sourceTargetKind",
  "source_target_kind",
  "targetKind",
  "target_kind",
] as const;

function normalizedLowerText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function normalizedPriorityGroup(value: unknown): DistillationTargetPriorityGroup | null {
  const normalized = normalizedLowerText(value);
  if (!normalized) return null;
  if (!PRIORITY_GROUP_SET.has(normalized as DistillationTargetPriorityGroup)) return null;
  return normalized as DistillationTargetPriorityGroup;
}

function metadataLooksWiki(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false;
  for (const key of WIKI_HINT_GROUP_KEYS) {
    const value = normalizedLowerText(metadata[key]);
    if (value === "wiki" || value === "wiki_file") return true;
  }
  for (const key of WIKI_HINT_KIND_KEYS) {
    const value = normalizedLowerText(metadata[key]);
    if (value === "wiki_file") return true;
  }
  return false;
}

export function priorityGroupFromRowLike(row: {
  priorityGroup?: unknown;
  targetKind?: unknown;
}): DistillationTargetPriorityGroup {
  const fromPriority = normalizedPriorityGroup(row.priorityGroup);
  if (fromPriority) return fromPriority;
  const targetKind = normalizedLowerText(row.targetKind);
  if (targetKind === "web_ingest") return "web_ingest";
  if (targetKind === "wiki_file") return "wiki";
  if (targetKind === "vibe_memory") return "vibe_memory";
  return "knowledge_candidate";
}

export function resolveKnowledgeCandidatePriorityGroup(params: {
  sourceUri?: string | null;
  metadata?: Record<string, unknown>;
}): DistillationTargetPriorityGroup {
  const explicit = normalizedPriorityGroup(params.metadata?.priorityGroup);
  if (explicit) return explicit;
  if (metadataLooksWiki(params.metadata)) return "wiki";
  const sourceUri = normalizedLowerText(params.sourceUri);
  if (sourceUri?.startsWith("wiki://")) return "wiki";
  return "knowledge_candidate";
}
