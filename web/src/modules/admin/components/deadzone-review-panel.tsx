import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useMemo, useState } from "react";
import type {
  DeadZoneKnowledgeReviewBadge,
  DeadZoneKnowledgeReviewItem,
  DeadZoneKnowledgeReviewReason,
  DeadZoneKnowledgeReviewResponse,
} from "../repositories/admin.repository";

type DeadZoneReviewPanelProps = {
  data: DeadZoneKnowledgeReviewResponse | undefined;
  isLoading: boolean;
  errorMessage: string | null;
  reason: DeadZoneKnowledgeReviewReason;
  badge: DeadZoneKnowledgeReviewBadge | "all";
  onReasonChange: (reason: DeadZoneKnowledgeReviewReason) => void;
  onBadgeChange: (badge: DeadZoneKnowledgeReviewBadge | "all") => void;
  onSelectKnowledge: (knowledgeId: string) => void;
};

const badgeOptions: Array<DeadZoneKnowledgeReviewBadge | "all"> = [
  "all",
  "Strong merge candidate",
  "Canonical candidate",
  "Likely duplicate",
  "Scope differs",
  "Evidence thin",
  "Stale",
  "Niche but valid",
  "Needs embedding",
  "Similarity unavailable",
];

function reasonLabel(value: DeadZoneKnowledgeReviewReason): string {
  switch (value) {
    case "dead_zone_reachability_risk":
      return "Reachability risk";
    case "dead_zone_stale":
      return "Stale";
    default:
      return "All DeadZone";
  }
}

function actionLabel(
  value: DeadZoneKnowledgeReviewItem["similarKnowledge"][number]["suggestedAction"],
) {
  switch (value) {
    case "merge_into_similar":
      return "Merge target";
    case "deadzone_is_canonical":
      return "DeadZone canonical";
    case "likely_duplicate":
      return "Likely duplicate";
    case "scope_differs":
      return "Scope differs";
    case "needs_evidence":
      return "Needs evidence";
    default:
      return "Keep separate";
  }
}

function actionClass(
  value: DeadZoneKnowledgeReviewItem["similarKnowledge"][number]["suggestedAction"],
) {
  if (value === "merge_into_similar" || value === "likely_duplicate") {
    return "border-amber-300 text-amber-100";
  }
  if (value === "deadzone_is_canonical") return "border-emerald-300 text-emerald-100";
  if (value === "scope_differs") return "border-sky-300 text-sky-100";
  if (value === "needs_evidence") return "border-rose-300 text-rose-100";
  return "border-slate-300 text-slate-100";
}

function badgeClass(value: DeadZoneKnowledgeReviewBadge): string {
  if (value === "Strong merge candidate" || value === "Likely duplicate") {
    return "border-amber-300 text-amber-100";
  }
  if (value === "Canonical candidate" || value === "Niche but valid") {
    return "border-emerald-300 text-emerald-100";
  }
  if (value === "Evidence thin" || value === "Stale" || value === "Needs embedding") {
    return "border-rose-300 text-rose-100";
  }
  if (value === "Scope differs") return "border-sky-300 text-sky-100";
  return "border-slate-300 text-slate-100";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function DeadZoneReviewRow(props: {
  item: DeadZoneKnowledgeReviewItem;
  expanded: boolean;
  onToggle: () => void;
  onSelectKnowledge: (knowledgeId: string) => void;
}) {
  const topSimilar = props.item.similarKnowledge[0];
  return (
    <div className="graph-review-row">
      <div className="graph-review-row-head">
        <Badge variant="outline" className="h-5 border-rose-300 text-[11px] text-rose-100">
          {reasonLabel(props.item.classification.primary)}
        </Badge>
        {props.item.indicators.badges.slice(0, 3).map((badge) => (
          <Badge
            key={`${props.item.knowledge.id}:${badge}`}
            variant="outline"
            className={`h-5 text-[11px] ${badgeClass(badge)}`}
          >
            {badge}
          </Badge>
        ))}
        <span>{props.item.classification.confidence}</span>
      </div>
      <p>{props.item.knowledge.title}</p>
      <small>
        {props.item.knowledge.communityLabel ?? props.item.knowledge.communityKey ?? "community:-"}{" "}
        / evidence {props.item.indicators.evidenceStrength} / usage{" "}
        {props.item.indicators.usageStrength} / selected {props.item.knowledge.compileSelectCount}
      </small>
      <small>{props.item.knowledge.bodyPreview}</small>
      {topSimilar ? (
        <small>
          nearest {percent(topSimilar.similarity)} / {topSimilar.title} /{" "}
          {actionLabel(topSimilar.suggestedAction)}
        </small>
      ) : (
        <small>No similar active knowledge above threshold.</small>
      )}
      <div className="graph-review-row-actions">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={() => props.onSelectKnowledge(props.item.knowledge.id)}
        >
          Select
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={props.onToggle}
        >
          {props.expanded ? "Hide Similar" : "Show Similar"}
        </Button>
      </div>
      {props.expanded ? (
        <div className="graph-review-list">
          {props.item.similarKnowledge.length > 0 ? (
            props.item.similarKnowledge.map((similar) => (
              <div className="graph-review-row" key={`${props.item.knowledge.id}:${similar.id}`}>
                <div className="graph-review-row-head">
                  <Badge
                    variant="outline"
                    className={`h-5 text-[11px] ${actionClass(similar.suggestedAction)}`}
                  >
                    {actionLabel(similar.suggestedAction)}
                  </Badge>
                  <span>{percent(similar.similarity)}</span>
                  <span>scope {similar.applicabilityMatch}</span>
                </div>
                <p>{similar.title}</p>
                <small>
                  status {similar.status} / evidence {similar.evidenceStrength} / usage{" "}
                  {similar.usageStrength}
                </small>
                <small>{similar.reasons.slice(0, 4).join(" / ")}</small>
              </div>
            ))
          ) : (
            <div className="graph-detail-empty">No similar knowledge for this item.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function DeadZoneReviewPanel(props: DeadZoneReviewPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(8);
  const items = props.data?.items ?? [];
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const hasMoreItems = visibleItems.length < items.length;

  return (
    <div className="graph-review-section">
      <div className="graph-review-section-header">
        <span>DeadZone Knowledge Review</span>
        <strong>{props.data?.itemCount ?? 0}</strong>
      </div>
      <div className="graph-review-actions">
        <Select
          aria-label="deadzone-reason-filter"
          value={props.reason}
          onChange={(event) =>
            props.onReasonChange(event.target.value as DeadZoneKnowledgeReviewReason)
          }
          className="h-7 text-[11px]"
        >
          <option value="all">all reasons</option>
          <option value="dead_zone_reachability_risk">reachability</option>
          <option value="dead_zone_stale">stale</option>
        </Select>
        <Select
          aria-label="deadzone-badge-filter"
          value={props.badge}
          onChange={(event) =>
            props.onBadgeChange(event.target.value as DeadZoneKnowledgeReviewBadge | "all")
          }
          className="h-7 text-[11px]"
        >
          {badgeOptions.map((option) => (
            <option key={option} value={option}>
              {option === "all" ? "all badges" : option}
            </option>
          ))}
        </Select>
        {props.data ? (
          <span className="graph-review-status-note">
            communities {props.data.communityCount} / threshold {percent(props.data.minSimilarity)}
          </span>
        ) : null}
      </div>
      {props.isLoading ? (
        <div className="graph-detail-empty">Loading DeadZone knowledge...</div>
      ) : props.errorMessage ? (
        <div className="graph-detail-empty">{props.errorMessage}</div>
      ) : props.data?.unavailableReason ? (
        <div className="graph-detail-empty">{props.data.unavailableReason}</div>
      ) : visibleItems.length > 0 ? (
        <>
          <div className="graph-review-list">
            {visibleItems.map((item) => (
              <DeadZoneReviewRow
                key={item.knowledge.id}
                item={item}
                expanded={expandedId === item.knowledge.id}
                onToggle={() =>
                  setExpandedId((current) =>
                    current === item.knowledge.id ? null : item.knowledge.id,
                  )
                }
                onSelectKnowledge={props.onSelectKnowledge}
              />
            ))}
          </div>
          {hasMoreItems ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-full text-[11px]"
              onClick={() => setVisibleCount((current) => Math.min(current + 8, items.length))}
            >
              Show More ({visibleItems.length}/{items.length})
            </Button>
          ) : null}
        </>
      ) : (
        <div className="graph-detail-empty">No DeadZone knowledge for current filters.</div>
      )}
    </div>
  );
}
