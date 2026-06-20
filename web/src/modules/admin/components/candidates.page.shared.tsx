import type { CandidateListItem, CandidateOutcome } from "../repositories/admin.repository";

export const compactBadgeClass =
  "text-[10px] whitespace-normal break-words [overflow-wrap:anywhere]";
export const tableHeadClass = "px-3 whitespace-normal break-words [overflow-wrap:anywhere]";
export const tableCellClass =
  "px-3 py-3 align-top whitespace-normal break-words [overflow-wrap:anywhere]";

export function coverageBadge(status: string): "success" | "warning" | "destructive" | "secondary" {
  if (status === "knowledge_ready") return "success";
  if (
    status === "duplicate" ||
    status === "near_duplicate" ||
    status === "insufficient" ||
    status === "reprocess_requested"
  ) {
    return "warning";
  }
  if (status === "tool_failed" || status === "provider_failed" || status === "parse_failed") {
    return "destructive";
  }
  return "secondary";
}

export function outcomeBadge(
  outcome: CandidateOutcome,
): "success" | "warning" | "destructive" | "secondary" {
  if (outcome === "stored") return "success";
  if (outcome === "ready_not_finalized" || outcome === "target_pending") return "warning";
  if (outcome === "rejected" || outcome === "retryable") return "destructive";
  if (outcome === "retained_failure") return "secondary";
  return "secondary";
}

export function outcomeLabel(outcome: CandidateOutcome): string {
  const labels: Record<CandidateOutcome, string> = {
    stored: "Stored",
    ready_not_finalized: "Ready to store",
    rejected: "Rejected",
    retryable: "Retryable",
    retained_failure: "Failed",
    candidate_only: "Uncovered",
    target_pending: "Pending",
  };
  return labels[outcome];
}

export function nextCandidateAction(item: CandidateListItem): string {
  if (item.landscapeWarning) return "Review landscape warning";
  if (item.outcome === "ready_not_finalized") return "Finalize into knowledge";
  if (item.outcome === "retryable") return "Wait for queued retry";
  if (item.outcome === "retained_failure") return "Inspect failure reason";
  if (item.outcome === "rejected") return "Review rejection";
  if (item.outcome === "target_pending") return "Wait for pipeline";
  if (item.outcome === "candidate_only") return "Run evidence coverage";
  return "Open knowledge item";
}

export function textPreview(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

export function initialTargetStateIdFromLocation(): string {
  if (typeof window === "undefined") return "";
  const value = new URLSearchParams(window.location.search).get("targetStateId") ?? "";
  return value.trim();
}

export function landscapeWarningSummary(item: CandidateListItem): string | null {
  if (!item.landscapeWarning) return null;
  if (item.landscapeWarning.warningReason === "promotion_gate_review") {
    return "promotion gate review required";
  }
  if (item.landscapeWarning.warningReason === "review_required") {
    return "manual review required";
  }
  return item.landscapeWarning.reason;
}

export function CandidateColumnGroup() {
  return (
    <colgroup>
      <col className="w-[30%]" />
      <col className="w-[18%]" />
      <col className="w-[14%]" />
      <col className="w-[16%]" />
      <col className="w-[14%]" />
      <col className="w-[8%]" />
    </colgroup>
  );
}

export function CandidateDetailPane({
  sectionTitle,
  candidateTitle,
  candidateBody,
  type,
  importance,
  confidence,
}: {
  sectionTitle: string;
  candidateTitle: string | null;
  candidateBody: string | null;
  type?: string | null;
  importance?: number | null;
  confidence?: number | null;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2 min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {sectionTitle}
      </p>
      <p className="text-xs font-semibold break-words [overflow-wrap:anywhere]">
        {candidateTitle ? textPreview(candidateTitle, 120) : "-"}
      </p>
      <p className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
        {candidateBody ? textPreview(candidateBody, 180) : "-"}
      </p>
      <div className="text-[11px] text-muted-foreground break-words [overflow-wrap:anywhere]">
        type: {type ?? "-"} | importance: {importance ?? "-"} | confidence: {confidence ?? "-"}
      </div>
    </div>
  );
}
