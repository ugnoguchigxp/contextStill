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
import { Archive, ArrowLeft, ArrowRight, ChevronsUpDown } from "lucide-react";
import { useMemo } from "react";
import type {
  DeadZoneKnowledgeMaintenanceAction,
  DeadZoneKnowledgeReviewBadge,
  DeadZoneKnowledgeReviewItem,
  DeadZoneKnowledgeReviewReason,
  DeadZoneKnowledgeReviewResponse,
  DeadZoneKnowledgeReviewSortBy,
} from "../repositories/admin.repository";

type DeadZoneReviewPanelProps = {
  data: DeadZoneKnowledgeReviewResponse | undefined;
  isLoading: boolean;
  errorMessage: string | null;
  sortBy: DeadZoneKnowledgeReviewSortBy;
  sortDir: "asc" | "desc";
  onSortChange: (sortBy: DeadZoneKnowledgeReviewSortBy) => void;
  onMaintenanceAction: (input: {
    action: DeadZoneKnowledgeMaintenanceAction;
    deadZoneKnowledgeId: string;
    similarKnowledgeId?: string;
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
    return "border-amber-300 bg-amber-50 text-amber-800";
  }
  if (value === "deadzone_is_canonical") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (value === "scope_differs") return "border-sky-300 bg-sky-50 text-sky-800";
  if (value === "needs_evidence") return "border-rose-300 bg-rose-50 text-rose-800";
  return "border-slate-300 bg-slate-50 text-slate-700";
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
}) {
  const isActive = props.activeSortBy === props.sortKey;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-1 text-xs font-semibold"
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

function SimilarGroupCell({
  item,
  actionPending,
  onMaintenanceAction,
}: {
  item: DeadZoneKnowledgeReviewItem;
  actionPending: boolean;
  onMaintenanceAction: DeadZoneReviewPanelProps["onMaintenanceAction"];
}) {
  if (item.similarKnowledge.length === 0) {
    return <span className="landscape-table-muted">No close active knowledge</span>;
  }
  return (
    <div className="landscape-similar-group">
      {item.similarKnowledge.slice(0, 4).map((similar) => (
        <div key={`${item.knowledge.id}:${similar.id}`} className="landscape-similar-item">
          <div className="landscape-similar-item-head">
            <Badge
              variant="outline"
              className={`h-5 text-[11px] ${actionClass(similar.suggestedAction)}`}
            >
              {actionLabel(similar.suggestedAction)}
            </Badge>
            <span>{percent(similar.similarity)}</span>
            <span>scope {similar.applicabilityMatch}</span>
          </div>
          <strong>{similar.title}</strong>
          <small>
            evidence {similar.evidenceStrength} / usage {similar.usageStrength}
          </small>
          <small>{similar.reasons.slice(0, 3).join(" / ")}</small>
          <div className="landscape-row-actions">
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-7 w-7"
              title="Merge DeadZone into similar knowledge"
              aria-label={`Merge ${item.knowledge.title} into ${similar.title}`}
              disabled={actionPending}
              onClick={() =>
                confirmMaintenance(
                  `Merge "${item.knowledge.title}" into "${similar.title}" and deprecate the DeadZone item?`,
                  () =>
                    onMaintenanceAction({
                      action: "merge_deadzone_into_similar",
                      deadZoneKnowledgeId: item.knowledge.id,
                      similarKnowledgeId: similar.id,
                    }),
                )
              }
            >
              <ArrowRight size={14} />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-7 w-7"
              title="Merge similar knowledge into DeadZone item"
              aria-label={`Merge ${similar.title} into ${item.knowledge.title}`}
              disabled={actionPending}
              onClick={() =>
                confirmMaintenance(
                  `Merge "${similar.title}" into "${item.knowledge.title}" and deprecate the similar item?`,
                  () =>
                    onMaintenanceAction({
                      action: "merge_similar_into_deadzone",
                      deadZoneKnowledgeId: item.knowledge.id,
                      similarKnowledgeId: similar.id,
                    }),
                )
              }
            >
              <ArrowLeft size={14} />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-7 w-7 border-orange-200 text-orange-700 hover:bg-orange-50"
              title="Deprecate similar knowledge"
              aria-label={`Deprecate ${similar.title}`}
              disabled={actionPending}
              onClick={() =>
                confirmMaintenance(`Deprecate similar knowledge "${similar.title}"?`, () =>
                  onMaintenanceAction({
                    action: "deprecate_similar",
                    deadZoneKnowledgeId: item.knowledge.id,
                    similarKnowledgeId: similar.id,
                  }),
                )
              }
            >
              <Archive size={14} />
            </Button>
          </div>
        </div>
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
        id: "similar",
        header: () => (
          <SortHeader
            label="Similar Group"
            sortKey="similarity"
            activeSortBy={props.sortBy}
            sortDir={props.sortDir}
            onSortChange={props.onSortChange}
          />
        ),
        cell: ({ row }) => (
          <SimilarGroupCell
            item={row.original}
            actionPending={props.actionPending}
            onMaintenanceAction={props.onMaintenanceAction}
          />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7 border-orange-200 text-orange-700 hover:bg-orange-50"
            title="Deprecate DeadZone knowledge"
            aria-label={`Deprecate ${row.original.knowledge.title}`}
            disabled={props.actionPending}
            onClick={() =>
              confirmMaintenance(
                `Deprecate DeadZone knowledge "${row.original.knowledge.title}"?`,
                () =>
                  props.onMaintenanceAction({
                    action: "deprecate_deadzone",
                    deadZoneKnowledgeId: row.original.knowledge.id,
                  }),
              )
            }
          >
            <Archive size={14} />
          </Button>
        ),
      },
    ],
    [
      props.actionPending,
      props.onMaintenanceAction,
      props.onSortChange,
      props.sortBy,
      props.sortDir,
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
