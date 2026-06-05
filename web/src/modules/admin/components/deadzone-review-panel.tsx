import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Archive, ChevronsUpDown, FileWarning, GitMerge, ShieldCheck, Star } from "lucide-react";
import { useMemo } from "react";
import type {
  DeadZoneKnowledgeReviewBadge,
  DeadZoneKnowledgeReviewItem,
  DeadZoneKnowledgeReviewReason,
  DeadZoneKnowledgeReviewResponse,
  DeadZoneKnowledgeReviewSortBy,
  DeadZoneRecommendationAction,
  DeadZoneSimilarKnowledge,
} from "../repositories/admin.repository";

type DeadZoneReviewPanelProps = {
  data: DeadZoneKnowledgeReviewResponse | undefined;
  isLoading: boolean;
  errorMessage: string | null;
  sortBy: DeadZoneKnowledgeReviewSortBy;
  sortDir: "asc" | "desc";
  onSortChange: (sortBy: DeadZoneKnowledgeReviewSortBy) => void;
  sortDisabled?: boolean;
  onReviewAction: (input: {
    action: DeadZoneRecommendationAction;
    deadZoneKnowledgeId: string;
    canonicalKnowledgeId?: string;
    reviewItemId?: string;
  }) => void;
  actionPending: boolean;
};

function reasonLabel(value: DeadZoneKnowledgeReviewReason): string {
  switch (value) {
    case "dead_zone_reachability_risk":
      return "Reachability";
    case "dead_zone_stale":
      return "Stale";
    default:
      return "DeadZone";
  }
}

function badgeClass(value: DeadZoneKnowledgeReviewBadge): string {
  if (value === "Strong merge candidate" || value === "Likely duplicate") {
    return "border-amber-300 bg-amber-50 text-amber-800";
  }
  if (value === "Canonical candidate" || value === "Niche but valid") {
    return "border-emerald-300 bg-emerald-50 text-emerald-800";
  }
  if (value === "Evidence thin" || value === "Stale" || value === "Needs embedding") {
    return "border-rose-300 bg-rose-50 text-rose-800";
  }
  if (value === "Scope differs") return "border-sky-300 bg-sky-50 text-sky-800";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function SortHeader(props: {
  label: string;
  sortKey: DeadZoneKnowledgeReviewSortBy;
  activeSortBy: DeadZoneKnowledgeReviewSortBy;
  sortDir: "asc" | "desc";
  onSortChange: (sortBy: DeadZoneKnowledgeReviewSortBy) => void;
  disabled?: boolean;
}) {
  const isActive = props.activeSortBy === props.sortKey;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-1 text-xs font-semibold"
      disabled={props.disabled}
      onClick={() => props.onSortChange(props.sortKey)}
    >
      {props.label}
      <ChevronsUpDown size={13} className={isActive ? "opacity-100" : "opacity-45"} />
      {isActive ? <span className="landscape-sort-dir">{props.sortDir}</span> : null}
    </Button>
  );
}

function confirmMaintenance(message: string, action: () => void) {
  if (window.confirm(message)) action();
}

function recommendationLabel(value: DeadZoneRecommendationAction): string {
  switch (value) {
    case "merge_deadzone_into_canonical":
      return "Merge into canonical";
    case "deprecate_deadzone":
      return "Deprecate DeadZone";
    case "keep_separate":
      return "Keep separate";
    case "promote_deadzone":
      return "Promote DeadZone";
    case "needs_evidence":
      return "Needs evidence";
  }
}

function recommendationClass(value: DeadZoneRecommendationAction): string {
  if (value === "merge_deadzone_into_canonical") {
    return "border-amber-300 bg-amber-50 text-amber-800";
  }
  if (value === "promote_deadzone" || value === "keep_separate") {
    return "border-emerald-300 bg-emerald-50 text-emerald-800";
  }
  if (value === "deprecate_deadzone") return "border-orange-300 bg-orange-50 text-orange-800";
  return "border-rose-300 bg-rose-50 text-rose-800";
}

function CandidateSummary({ candidate }: { candidate: DeadZoneSimilarKnowledge | null }) {
  if (!candidate) {
    return <span className="landscape-table-muted">No reliable canonical candidate</span>;
  }
  return (
    <div className="landscape-candidate-cell">
      <div className="landscape-candidate-head">
        <Badge variant="outline" className="h-5 border-slate-300 bg-slate-50 text-[11px]">
          {percent(candidate.similarity)}
        </Badge>
        <span>scope {candidate.applicabilityMatch}</span>
      </div>
      <strong>{candidate.title}</strong>
      <small>
        evidence {candidate.evidenceStrength} / usage {candidate.usageStrength}
      </small>
      <small>{candidate.reasons.slice(0, 3).join(" / ")}</small>
    </div>
  );
}

function RecommendationCell({ item }: { item: DeadZoneKnowledgeReviewItem }) {
  return (
    <div className="landscape-recommendation-cell">
      <Badge
        variant="outline"
        className={`h-5 text-[11px] ${recommendationClass(item.recommendation.action)}`}
      >
        {recommendationLabel(item.recommendation.action)}
      </Badge>
      <small>confidence {item.recommendation.confidence}</small>
      {item.recommendation.reasons.slice(0, 3).map((reason) => (
        <small key={`${item.knowledge.id}:reason:${reason}`}>{reason}</small>
      ))}
      {item.recommendation.blockers.length > 0 ? (
        <small className="landscape-blocker-text">
          blockers {item.recommendation.blockers.join(" / ")}
        </small>
      ) : null}
    </div>
  );
}

function actionIcon(value: DeadZoneRecommendationAction) {
  switch (value) {
    case "merge_deadzone_into_canonical":
      return <GitMerge size={14} />;
    case "deprecate_deadzone":
      return <Archive size={14} />;
    case "keep_separate":
      return <ShieldCheck size={14} />;
    case "promote_deadzone":
      return <Star size={14} />;
    case "needs_evidence":
      return <FileWarning size={14} />;
  }
}

function DecisionCell({
  item,
  actionPending,
  onReviewAction,
}: {
  item: DeadZoneKnowledgeReviewItem;
  actionPending: boolean;
  onReviewAction: DeadZoneReviewPanelProps["onReviewAction"];
}) {
  const orderedActions = [
    item.recommendation.action,
    "keep_separate",
    "needs_evidence",
    "deprecate_deadzone",
  ].filter(
    (action, index, values): action is DeadZoneRecommendationAction =>
      item.allowedActions.includes(action as DeadZoneRecommendationAction) &&
      values.indexOf(action) === index,
  );

  return (
    <div className="landscape-row-actions">
      {orderedActions.map((action) => (
        <Button
          key={`${item.knowledge.id}:${action}`}
          type="button"
          variant={action === item.recommendation.action ? "default" : "outline"}
          className="landscape-action-button"
          aria-label={`${recommendationLabel(action)} for ${item.knowledge.title}`}
          disabled={
            actionPending ||
            (action === "merge_deadzone_into_canonical" && !item.bestCanonicalCandidate)
          }
          onClick={() => {
            const run = () =>
              onReviewAction({
                action,
                deadZoneKnowledgeId: item.knowledge.id,
                canonicalKnowledgeId:
                  action === "merge_deadzone_into_canonical"
                    ? item.bestCanonicalCandidate?.id
                    : undefined,
                reviewItemId: item.reviewItemId ?? undefined,
              });
            if (action === "merge_deadzone_into_canonical") {
              confirmMaintenance(
                `Merge "${item.knowledge.title}" into canonical "${item.bestCanonicalCandidate?.title}" and deprecate the DeadZone item?`,
                run,
              );
              return;
            }
            if (action === "deprecate_deadzone") {
              confirmMaintenance(`Deprecate DeadZone knowledge "${item.knowledge.title}"?`, run);
              return;
            }
            run();
          }}
        >
          {actionIcon(action)}
          <span>{recommendationLabel(action)}</span>
        </Button>
      ))}
    </div>
  );
}

export function DeadZoneReviewPanel(props: DeadZoneReviewPanelProps) {
  const items = props.data?.items ?? [];

  const columns = useMemo<ColumnDef<DeadZoneKnowledgeReviewItem>[]>(
    () => [
      {
        id: "score",
        header: () => (
          <SortHeader
            label="Score"
            sortKey="deadZoneScore"
            activeSortBy={props.sortBy}
            sortDir={props.sortDir}
            onSortChange={props.onSortChange}
            disabled={props.sortDisabled}
          />
        ),
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className="h-5 border-red-300 bg-red-50 text-[11px] text-red-800"
          >
            score {row.original.indicators.deadZoneScore}
          </Badge>
        ),
      },
      {
        id: "knowledge",
        header: () => (
          <SortHeader
            label="Knowledge"
            sortKey="title"
            activeSortBy={props.sortBy}
            sortDir={props.sortDir}
            onSortChange={props.onSortChange}
            disabled={props.sortDisabled}
          />
        ),
        cell: ({ row }) => (
          <div className="landscape-knowledge-cell">
            <strong>{row.original.knowledge.title}</strong>
            <small>{row.original.knowledge.bodyPreview}</small>
            <small>
              {row.original.knowledge.communityLabel ??
                row.original.knowledge.communityKey ??
                "community:-"}{" "}
              / selected {row.original.knowledge.compileSelectCount}
            </small>
          </div>
        ),
      },
      {
        id: "signals",
        header: () => (
          <SortHeader
            label="Signals"
            sortKey="evidence"
            activeSortBy={props.sortBy}
            sortDir={props.sortDir}
            onSortChange={props.onSortChange}
            disabled={props.sortDisabled}
          />
        ),
        cell: ({ row }) => (
          <div className="landscape-signal-cell">
            <Badge
              variant="outline"
              className="h-5 border-rose-300 bg-rose-50 text-[11px] text-rose-800"
            >
              {reasonLabel(row.original.classification.primary)}
            </Badge>
            {row.original.indicators.badges.slice(0, 4).map((badge) => (
              <Badge
                key={`${row.original.knowledge.id}:${badge}`}
                variant="outline"
                className={`h-5 text-[11px] ${badgeClass(badge)}`}
              >
                {badge}
              </Badge>
            ))}
            <small>
              evidence {row.original.indicators.evidenceStrength} / usage{" "}
              {row.original.indicators.usageStrength} / graph {row.original.indicators.graphHealth}
            </small>
          </div>
        ),
      },
      {
        id: "candidate",
        header: () => (
          <SortHeader
            label="Best Candidate"
            sortKey="similarity"
            activeSortBy={props.sortBy}
            sortDir={props.sortDir}
            onSortChange={props.onSortChange}
            disabled={props.sortDisabled}
          />
        ),
        cell: ({ row }) => <CandidateSummary candidate={row.original.bestCanonicalCandidate} />,
      },
      {
        id: "recommendation",
        header: "Recommendation",
        cell: ({ row }) => <RecommendationCell item={row.original} />,
      },
      {
        id: "decision",
        header: "Decision",
        cell: ({ row }) => (
          <DecisionCell
            item={row.original}
            actionPending={props.actionPending}
            onReviewAction={props.onReviewAction}
          />
        ),
      },
    ],
    [
      props.actionPending,
      props.onReviewAction,
      props.onSortChange,
      props.sortBy,
      props.sortDir,
      props.sortDisabled,
    ],
  );

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="graph-review-section">
      <div className="graph-review-section-header">
        <span>DeadZone Knowledge</span>
        <strong>{props.data?.itemCount ?? 0}</strong>
      </div>
      {props.data ? (
        <span className="graph-review-status-note">
          communities {props.data.communityCount} / threshold {percent(props.data.minSimilarity)}
        </span>
      ) : null}
      {props.isLoading ? (
        <div className="graph-detail-empty">Loading DeadZone knowledge...</div>
      ) : props.errorMessage ? (
        <div className="graph-detail-empty">{props.errorMessage}</div>
      ) : props.data?.unavailableReason ? (
        <div className="graph-detail-empty">{props.data.unavailableReason}</div>
      ) : items.length > 0 ? (
        <>
          <Table className="landscape-review-table">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="align-top whitespace-normal">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : (
        <div className="graph-detail-empty">No DeadZone knowledge for current filters.</div>
      )}
    </div>
  );
}
