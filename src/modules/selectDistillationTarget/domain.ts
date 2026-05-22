export type DistillationTargetKind = "wiki_file" | "vibe_memory" | "knowledge_candidate";

export type DistillationTargetStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "paused";

export type DistillationTargetPhase =
  | "selected"
  | "reading"
  | "finding_candidate"
  | "covering_evidence"
  | "finalizing"
  | "stored";

export type DistillationTargetPriorityGroup = "knowledge_candidate" | "wiki" | "vibe_memory";

export type DistillationTargetCandidate = {
  targetKind: DistillationTargetKind;
  targetKey: string;
  sourceUri: string;
  status?: DistillationTargetStatus;
  sortKey?: string;
  createdAt?: Date;
};

export type SelectedDistillationTarget = {
  targetKind: DistillationTargetKind;
  targetKey: string;
  sourceUri: string;
  status: DistillationTargetStatus;
};

function statusOf(candidate: DistillationTargetCandidate): DistillationTargetStatus {
  return candidate.status ?? "pending";
}

function isSelectable(candidate: DistillationTargetCandidate): boolean {
  const status = statusOf(candidate);
  return status === "pending" || status === "paused";
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

function compareWikiTarget(a: DistillationTargetCandidate, b: DistillationTargetCandidate): number {
  const sortKeyCompare = compareText(a.sortKey ?? a.targetKey, b.sortKey ?? b.targetKey);
  if (sortKeyCompare !== 0) return sortKeyCompare;
  return compareText(a.targetKey, b.targetKey);
}

function compareVibeMemoryTarget(
  a: DistillationTargetCandidate,
  b: DistillationTargetCandidate,
): number {
  const aTime = a.createdAt?.getTime() ?? 0;
  const bTime = b.createdAt?.getTime() ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  return compareText(a.targetKey, b.targetKey);
}

function compareKnowledgeCandidateTarget(
  a: DistillationTargetCandidate,
  b: DistillationTargetCandidate,
): number {
  const sortKeyCompare = compareText(a.sortKey ?? a.targetKey, b.sortKey ?? b.targetKey);
  if (sortKeyCompare !== 0) return sortKeyCompare;
  return compareText(a.targetKey, b.targetKey);
}

function toSelected(candidate: DistillationTargetCandidate): SelectedDistillationTarget {
  return {
    targetKind: candidate.targetKind,
    targetKey: candidate.targetKey,
    sourceUri: candidate.sourceUri,
    status: statusOf(candidate),
  };
}

export function selectDistillationTarget(
  candidates: DistillationTargetCandidate[],
): SelectedDistillationTarget | null {
  const selectable = candidates.filter(isSelectable);
  const knowledgeCandidateTarget = selectable
    .filter((candidate) => candidate.targetKind === "knowledge_candidate")
    .sort(compareKnowledgeCandidateTarget)[0];
  if (knowledgeCandidateTarget) return toSelected(knowledgeCandidateTarget);

  const wikiTarget = selectable
    .filter((candidate) => candidate.targetKind === "wiki_file")
    .sort(compareWikiTarget)[0];
  if (wikiTarget) return toSelected(wikiTarget);

  const vibeMemoryTarget = selectable
    .filter((candidate) => candidate.targetKind === "vibe_memory")
    .sort(compareVibeMemoryTarget)[0];
  return vibeMemoryTarget ? toSelected(vibeMemoryTarget) : null;
}

export function priorityGroupForTargetKind(
  targetKind: DistillationTargetKind,
): DistillationTargetPriorityGroup {
  if (targetKind === "knowledge_candidate") return "knowledge_candidate";
  return targetKind === "wiki_file" ? "wiki" : "vibe_memory";
}

export function sortKeyForTarget(candidate: DistillationTargetCandidate): string {
  if (candidate.sortKey?.trim()) return candidate.sortKey.trim();
  if (candidate.targetKind === "wiki_file") return candidate.targetKey.toLowerCase();
  if (candidate.targetKind === "knowledge_candidate") return candidate.targetKey;
  const createdAt = candidate.createdAt?.toISOString() ?? "9999-12-31T23:59:59.999Z";
  return `${createdAt}:${candidate.targetKey}`;
}

export function selectedTargetFromState(state: {
  targetKind: string;
  targetKey: string;
  sourceUri: string;
  status: string;
}): SelectedDistillationTarget {
  return {
    targetKind: state.targetKind as DistillationTargetKind,
    targetKey: state.targetKey,
    sourceUri: state.sourceUri,
    status: state.status as DistillationTargetStatus,
  };
}
