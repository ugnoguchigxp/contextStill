import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime as tzFormatDateTime, useTimezone } from "@/lib/timezone";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";
import { Fragment, useCallback, useMemo, useState } from "react";
import {
  type CandidateListItem,
  type CandidateListSortBy,
  type CandidateOutcome,
  fetchCandidateItems,
} from "../repositories/admin.repository";
import { AdminPaginationFooter } from "./admin-pagination-footer";
import { AdminSortableTableHead } from "./admin-sortable-table-head";

const outcomeOptions: Array<"all" | CandidateOutcome> = [
  "all",
  "stored",
  "ready_not_finalized",
  "rejected",
  "retryable",
  "candidate_only",
  "target_pending",
];

const tableHeadClass = "px-3 whitespace-normal break-words [overflow-wrap:anywhere]";
const tableCellClass = "px-3 py-3 align-top whitespace-normal break-words [overflow-wrap:anywhere]";
const compactBadgeClass = "text-[10px] whitespace-normal break-words [overflow-wrap:anywhere]";

function toPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function coverageBadge(status: string): "success" | "warning" | "destructive" | "secondary" {
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

function outcomeBadge(
  outcome: CandidateOutcome,
): "success" | "warning" | "destructive" | "secondary" {
  if (outcome === "stored") return "success";
  if (outcome === "ready_not_finalized" || outcome === "target_pending") return "warning";
  if (outcome === "rejected" || outcome === "retryable") return "destructive";
  return "secondary";
}

function diffSignals(item: CandidateListItem): string[] {
  const summary =
    item.diff.originalToKnowledge?.summary ?? item.diff.originalToCover?.summary ?? [];
  return summary.slice(0, 3);
}

function textPreview(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function initialTargetStateIdFromLocation(): string {
  if (typeof window === "undefined") return "";
  const value = new URLSearchParams(window.location.search).get("targetStateId") ?? "";
  return value.trim();
}

function landscapeWarningSummary(item: CandidateListItem): string | null {
  if (!item.landscapeWarning) return null;
  if (item.landscapeWarning.warningReason === "promotion_gate_review") {
    return "promotion gate review required";
  }
  if (item.landscapeWarning.warningReason === "review_required") {
    return "manual review required";
  }
  return item.landscapeWarning.reason;
}

function CandidateColumnGroup() {
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

function CandidateDetailPane({
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

export function CandidatesPage() {
  const tz = useTimezone();
  const formatDate = useCallback(
    (value: string | Date | null | undefined): string => {
      return tzFormatDateTime(value, tz);
    },
    [tz],
  );

  const [sorting, setSorting] = useState<SortingState>([{ id: "latestUpdatedAt", desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [queryText, setQueryText] = useState("");
  const [targetKind, setTargetKind] = useState<
    "all" | "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest"
  >("all");
  const [targetStateIdFilter, setTargetStateIdFilter] = useState(initialTargetStateIdFromLocation);
  const [outcome, setOutcome] = useState<"all" | CandidateOutcome>("all");
  const [hasKnowledge, setHasKnowledge] = useState<"all" | "yes" | "no">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const resetToFirstPage = useCallback(() => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  }, []);
  const serverSort = sorting[0] ?? { id: "latestUpdatedAt", desc: true };

  const candidatesQuery = useQuery({
    queryKey: [
      "candidates",
      {
        page: pagination.pageIndex + 1,
        limit: pagination.pageSize,
        queryText,
        targetKind,
        targetStateIdFilter,
        outcome,
        hasKnowledge,
        sortBy: serverSort.id,
        sortDir: serverSort.desc ? "desc" : "asc",
      },
    ],
    queryFn: () =>
      fetchCandidateItems({
        page: pagination.pageIndex + 1,
        limit: pagination.pageSize,
        query: queryText || undefined,
        targetKind,
        targetStateId: targetStateIdFilter || undefined,
        outcome,
        hasKnowledge,
        sortBy: serverSort.id as CandidateListSortBy,
        sortDir: serverSort.desc ? "desc" : "asc",
      }),
  });

  const items = candidatesQuery.data?.items ?? [];
  const stats = candidatesQuery.data?.stats;
  const total = candidatesQuery.data?.total ?? 0;
  const totalPages = candidatesQuery.data?.totalPages ?? 0;
  const currentPage = pagination.pageIndex + 1;
  const displayTotalPages = Math.max(1, totalPages);
  const hasPrev = currentPage > 1;
  const hasNext = totalPages > 0 && currentPage < totalPages;
  const pageStart = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min(pagination.pageIndex * pagination.pageSize + items.length, total);

  const columns = useMemo<ColumnDef<CandidateListItem>[]>(
    () => [
      {
        id: "targetKey",
        accessorFn: (item) => item.targetKey,
        header: "Target",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <Badge variant="outline" className={compactBadgeClass}>
                  {item.targetKind}
                </Badge>
                <Badge variant={outcomeBadge(item.outcome)} className={compactBadgeClass}>
                  {item.outcome}
                </Badge>
              </div>
              <p className="text-xs font-medium break-words [overflow-wrap:anywhere]">
                {item.targetKey}
              </p>
              <p className="text-[11px] text-muted-foreground">idx: {item.candidateIndex}</p>
              {item.landscapeWarning ? (
                <div className="space-y-1 pt-1">
                  <Badge variant="warning" className={compactBadgeClass}>
                    <AlertTriangle size={11} className="mr-1" />
                    Landscape warning
                  </Badge>
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 break-words [overflow-wrap:anywhere]">
                    {landscapeWarningSummary(item) ?? "manual approval required"}
                  </p>
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "candidateTitle",
        accessorFn: (item) => item.original.title,
        header: "Candidate",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <>
              <p className="text-xs font-semibold break-words [overflow-wrap:anywhere]">
                {item.original.title}
              </p>
              <p className="text-[11px] text-muted-foreground break-words [overflow-wrap:anywhere]">
                {textPreview(item.original.body, 100)}
              </p>
            </>
          );
        },
      },
      {
        id: "coverageStatus",
        accessorFn: (item) => item.cover?.status ?? "",
        header: "Coverage",
        cell: ({ row }) => {
          const item = row.original;
          return item.cover ? (
            <div className="min-w-0 space-y-1">
              <Badge variant={coverageBadge(item.cover.status)} className={compactBadgeClass}>
                {item.cover.status}
              </Badge>
              <p className="text-[11px] text-muted-foreground">stage: {item.cover.stage}</p>
              <p className="text-[11px] text-muted-foreground break-words [overflow-wrap:anywhere]">
                {item.cover.reason ?? "-"}
              </p>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">no cover result</span>
          );
        },
      },
      {
        id: "knowledgeStatus",
        accessorFn: (item) => item.knowledge?.status ?? "",
        header: "Knowledge",
        cell: ({ row }) => {
          const item = row.original;
          return item.knowledge ? (
            <div className="min-w-0 space-y-1">
              <Badge variant="success" className={compactBadgeClass}>
                {item.knowledge.status}
              </Badge>
              <Link
                to="/knowledge"
                className="block text-[11px] text-blue-600 hover:underline break-words [overflow-wrap:anywhere]"
                onClick={(event) => event.stopPropagation()}
              >
                {item.knowledge.id}
              </Link>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">not stored</span>
          );
        },
      },
      {
        id: "qualityScore",
        accessorFn: (item) =>
          (item.cover?.importance ?? item.knowledge?.importance ?? 0) * 0.6 +
          (item.cover?.confidence ?? item.knowledge?.confidence ?? 0) * 0.4,
        header: "Quality",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <>
              <p className="text-[11px] text-muted-foreground">
                I: {item.cover?.importance ?? item.knowledge?.importance ?? "-"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                C: {item.cover?.confidence ?? item.knowledge?.confidence ?? "-"}
              </p>
            </>
          );
        },
      },
      {
        id: "diff",
        header: "Diff",
        enableSorting: false,
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex min-w-0 flex-wrap gap-1">
              {diffSignals(item).map((label) => (
                <Badge key={`${item.id}-${label}`} variant="outline" className={compactBadgeClass}>
                  {label}
                </Badge>
              ))}
              {item.diff.originalToKnowledge ? (
                <Badge variant="secondary" className={compactBadgeClass}>
                  sim {toPercent(item.diff.originalToKnowledge.bodySimilarity)}
                </Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "latestUpdatedAt",
        accessorFn: (item) => item.latestUpdatedAt,
        header: "Updated",
        cell: ({ row }) => (
          <span className="text-[11px] text-muted-foreground">
            {formatDate(row.original.latestUpdatedAt)}
          </span>
        ),
      },
    ],
    [formatDate],
  );

  const table = useReactTable({
    data: items,
    columns,
    state: {
      sorting,
      pagination,
    },
    onSortingChange: (updater) => {
      setSorting((current) => (typeof updater === "function" ? updater(current) : updater));
      resetToFirstPage();
    },
    onPaginationChange: setPagination,
    manualPagination: true,
    manualSorting: true,
    pageCount: totalPages,
    enableMultiSort: false,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden bg-background">
      <Card className="flex flex-1 flex-col overflow-hidden rounded-none border-0 shadow-none gap-0 py-0">
        <CardHeader className="border-b bg-muted/20 px-4 py-2">
          <div className="grid grid-cols-1 items-center gap-2 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search target / candidate / knowledge"
                value={queryText}
                className="h-9 pl-9"
                onChange={(event) => {
                  setQueryText(event.target.value);
                  resetToFirstPage();
                }}
              />
            </div>
            <Select
              aria-label="target-kind"
              value={targetKind}
              onChange={(event) => {
                setTargetKind(
                  event.target.value as
                    | "all"
                    | "wiki_file"
                    | "vibe_memory"
                    | "knowledge_candidate"
                    | "web_ingest",
                );
                resetToFirstPage();
              }}
            >
              <option value="all">all target kinds</option>
              <option value="wiki_file">wiki_file</option>
              <option value="web_ingest">web_ingest</option>
              <option value="vibe_memory">vibe_memory</option>
              <option value="knowledge_candidate">knowledge_candidate</option>
            </Select>
            <Select
              aria-label="outcome"
              value={outcome}
              onChange={(event) => {
                setOutcome(event.target.value as "all" | CandidateOutcome);
                resetToFirstPage();
              }}
            >
              {outcomeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <Select
              aria-label="has-knowledge"
              value={hasKnowledge}
              onChange={(event) => {
                setHasKnowledge(event.target.value as "all" | "yes" | "no");
                resetToFirstPage();
              }}
            >
              <option value="all">all knowledge states</option>
              <option value="yes">knowledge yes</option>
              <option value="no">knowledge no</option>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 justify-self-end"
              onClick={() => candidatesQuery.refetch()}
              disabled={candidatesQuery.isFetching}
            >
              <RefreshCw size={14} className={candidatesQuery.isFetching ? "animate-spin" : ""} />
              Refresh
            </Button>
          </div>
          {targetStateIdFilter ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[11px]">
                targetStateId: {targetStateIdFilter}
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setTargetStateIdFilter("");
                  resetToFirstPage();
                }}
              >
                Clear Target Filter
              </Button>
            </div>
          ) : null}
        </CardHeader>

        <div className="min-w-0 flex flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b bg-background/95 shadow-sm">
            <table className="w-full table-fixed caption-bottom text-sm">
              <CandidateColumnGroup />
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <AdminSortableTableHead
                        key={header.id}
                        header={header}
                        className={tableHeadClass}
                      />
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
            </table>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full table-fixed caption-bottom text-sm">
              <CandidateColumnGroup />
              <TableBody>
                {candidatesQuery.isLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      Loading candidates...
                    </TableCell>
                  </TableRow>
                ) : null}
                {!candidatesQuery.isLoading && candidatesQuery.isError ? (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center text-sm text-destructive"
                    >
                      Failed to load candidates.
                    </TableCell>
                  </TableRow>
                ) : null}
                {!candidatesQuery.isLoading &&
                !candidatesQuery.isError &&
                table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      No candidates found.
                    </TableCell>
                  </TableRow>
                ) : null}
                {table.getRowModel().rows.map((row) => {
                  const item = row.original;
                  return (
                    <Fragment key={item.id}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id} className={tableCellClass}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                      {expandedId === item.id ? (
                        <TableRow className="bg-muted/20">
                          <TableCell
                            colSpan={columns.length}
                            className="px-3 py-4 whitespace-normal break-words [overflow-wrap:anywhere]"
                          >
                            <div className="grid min-w-0 gap-3 lg:grid-cols-3">
                              <CandidateDetailPane
                                sectionTitle="Original Candidate"
                                candidateTitle={item.original.title}
                                candidateBody={item.original.body}
                                type={null}
                              />
                              <CandidateDetailPane
                                sectionTitle="Covered Candidate"
                                candidateTitle={item.cover?.title ?? null}
                                candidateBody={item.cover?.body ?? null}
                                type={item.cover?.type ?? null}
                                importance={item.cover?.importance ?? null}
                                confidence={item.cover?.confidence ?? null}
                              />
                              <CandidateDetailPane
                                sectionTitle="Final Knowledge"
                                candidateTitle={item.knowledge?.title ?? null}
                                candidateBody={item.knowledge?.body ?? null}
                                type={item.knowledge?.type ?? null}
                                importance={item.knowledge?.importance ?? null}
                                confidence={item.knowledge?.confidence ?? null}
                              />
                            </div>
                            <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground lg:grid-cols-2">
                              <div className="min-w-0 rounded-lg border bg-background px-3 py-2 break-words [overflow-wrap:anywhere]">
                                <p>targetStateId: {item.targetStateId}</p>
                                <p>findCandidateResultId: {item.id}</p>
                                <p>coverEvidenceResultId: {item.id}</p>
                                <p>knowledgeId: {item.knowledge?.id ?? "-"}</p>
                                {item.landscapeWarning ? (
                                  <>
                                    <p>landscapeWarning: yes</p>
                                    <p>
                                      warningReason:{" "}
                                      {landscapeWarningSummary(item) ??
                                        item.landscapeWarning.warningReason}
                                    </p>
                                    <p>reviewItemId: {item.landscapeWarning.reviewItemId ?? "-"}</p>
                                    <p>linkStatus: {item.landscapeWarning.linkStatus ?? "-"}</p>
                                  </>
                                ) : (
                                  <p>landscapeWarning: no</p>
                                )}
                              </div>
                              <div className="min-w-0 rounded-lg border bg-background px-3 py-2 break-words [overflow-wrap:anywhere]">
                                <p>sourceUri: {item.sourceUri}</p>
                                <p>finalizeSourceUri: {item.finalizeSourceUri}</p>
                                <p>references: {item.cover?.referencesCount ?? 0}</p>
                                <p>duplicateRefs: {item.cover?.duplicateRefsCount ?? 0}</p>
                                <p>toolEvents: {item.cover?.toolEventsCount ?? 0}</p>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </table>
          </div>
        </div>

        <AdminPaginationFooter
          keyPrefix="candidate"
          currentPage={currentPage}
          totalPages={totalPages}
          canPreviousPage={hasPrev}
          canNextPage={hasNext}
          onPreviousPage={() => table.previousPage()}
          onNextPage={() => table.nextPage()}
          onPageSelect={(pageNumber) => table.setPageIndex(pageNumber - 1)}
          summaryItems={[
            `Showing ${pageStart} to ${pageEnd} of ${total} candidates | Page ${currentPage} / ${displayTotalPages}`,
            `total ${stats?.total ?? 0} | stored ${stats?.stored ?? 0} | ready ${stats?.readyNotFinalized ?? 0} | rejected ${stats?.rejected ?? 0} | retryable ${stats?.retryable ?? 0} | pending ${stats?.targetPending ?? 0}`,
          ]}
        />
      </Card>
    </div>
  );
}
