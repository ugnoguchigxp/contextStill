import { Badge } from "@/components/ui/badge";
import type { CandidateListItem, CandidateOutcome } from "../repositories/admin.repository";

export const outcomeOptions: Array<"all" | CandidateOutcome> = [
  "all",
  "stored",
  "ready_not_finalized",
  "rejected",
  "retryable",
  "retained_failure",
  "candidate_only",
  "target_pending",
];

export const tableHeadClass = "px-3 whitespace-normal break-words [overflow-wrap:anywhere]";
export const tableCellClass =
  "px-3 py-3 align-top whitespace-normal break-words [overflow-wrap:anywhere]";
export const compactBadgeClass =
  "text-[10px] whitespace-normal break-words [overflow-wrap:anywhere]";

export function toPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

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

export function diffSignals(item: CandidateListItem): string[] {
  const summary =
    item.diff.originalToKnowledge?.summary ?? item.diff.originalToCover?.summary ?? [];
  return summary.slice(0, 3);
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
      <col className="w-[18%]" />
      <col className="w-[25%]" />
      <col className="w-[14%]" />
      <col className="w-[14%]" />
      <col className="w-[8%]" />
      <col className="w-[13%]" />
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

export function LandscapeWarningBadge({
  warning,
}: { warning: CandidateListItem["landscapeWarning"] }) {
  if (!warning) return null;
  return (
    <div className="space-y-1 pt-1">
      <Badge variant="warning" className={compactBadgeClass}>
        Landscape warning
      </Badge>
      <p className="text-[11px] text-amber-700 dark:text-amber-300 break-words [overflow-wrap:anywhere]">
        {warning.reason}
      </p>
    </div>
  );
}
