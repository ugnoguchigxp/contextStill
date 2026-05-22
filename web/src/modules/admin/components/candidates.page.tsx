import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
} from "lucide-react";
import { Fragment, useCallback, useMemo, useState } from "react";
import {
  type CandidateListItem,
  type CandidateListSortBy,
  type CandidateOutcome,
  fetchCandidateItems,
} from "../repositories/admin.repository";

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

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ja-JP", { hour12: false });
}

function toPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function coverageBadge(status: string): "success" | "warning" | "destructive" | "secondary" {
  if (status === "knowledge_ready") return "success";
  if (status === "duplicate" || status === "near_duplicate" || status === "insufficient") {
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

function visiblePageNumbers(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 0) return [];
  if (totalPages <= 9) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, totalPages]);
  for (let pageNumber = currentPage - 2; pageNumber <= currentPage + 2; pageNumber += 1) {
    if (pageNumber >= 1 && pageNumber <= totalPages) pages.add(pageNumber);
  }

  const sortedPages = Array.from(pages).sort((a, b) => a - b);
  return sortedPages.flatMap((pageNumber, index) => {
    const previousPage = sortedPages[index - 1];
    return previousPage && pageNumber - previousPage > 1 ? ["ellipsis", pageNumber] : [pageNumber];
  });
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
  const [sorting, setSorting] = useState<SortingState>([{ id: "latestUpdatedAt", desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [queryText, setQueryText] = useState("");
  const [targetKind, setTargetKind] = useState<
    "all" | "wiki_file" | "vibe_memory" | "knowledge_candidate"
  >("all");
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
  const pageNumbers = visiblePageNumbers(currentPage, totalPages);
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
    [],
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
                  event.target.value as "all" | "wiki_file" | "vibe_memory" | "knowledge_candidate",
                );
                resetToFirstPage();
              }}
            >
              <option value="all">all target kinds</option>
              <option value="wiki_file">wiki_file</option>
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
        </CardHeader>

        <div className="min-w-0 flex flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b bg-background/95 shadow-sm">
            <table className="w-full table-fixed caption-bottom text-sm">
              <CandidateColumnGroup />
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id} className={tableHeadClass}>
                        {header.isPlaceholder ? null : header.column.getCanSort() ? (
                          <button
                            type="button"
                            className="flex cursor-pointer select-none items-center gap-2 transition-colors hover:text-foreground"
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <span className="w-4">
                              {{
                                asc: <ArrowUp size={12} />,
                                desc: <ArrowDown size={12} />,
                              }[header.column.getIsSorted() as string] ?? (
                                <ArrowUpDown size={12} className="opacity-30" />
                              )}
                            </span>
                          </button>
                        ) : (
                          <div>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </div>
                        )}
                      </TableHead>
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

        <div className="border-t bg-muted/10 px-4 py-1.5 flex flex-wrap items-center justify-between gap-3 text-[11px] leading-4">
          <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>
              Showing {pageStart} to {pageEnd} of {total} candidates | Page {currentPage} /{" "}
              {displayTotalPages}
            </span>
            <span>
              total {stats?.total ?? 0} | stored {stats?.stored ?? 0} | ready{" "}
              {stats?.readyNotFinalized ?? 0} | rejected {stats?.rejected ?? 0} | retryable{" "}
              {stats?.retryable ?? 0} | pending {stats?.targetPending ?? 0}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2"
              disabled={!hasPrev}
              onClick={() => table.previousPage()}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <div className="flex items-center gap-1">
              {pageNumbers.map((pageNumber, index) =>
                pageNumber === "ellipsis" ? (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: separator positions are derived from page windows
                    key={`candidate-page-ellipsis-${index}`}
                    className="px-1 text-xs text-muted-foreground"
                  >
                    ...
                  </span>
                ) : (
                  <button
                    key={`candidate-page-${pageNumber}`}
                    type="button"
                    className={`h-7 min-w-7 rounded-md px-2 text-xs transition-colors ${
                      currentPage === pageNumber
                        ? "bg-primary font-bold text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    onClick={() => table.setPageIndex(pageNumber - 1)}
                    aria-current={currentPage === pageNumber ? "page" : undefined}
                  >
                    {pageNumber}
                  </button>
                ),
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2"
              disabled={!hasNext}
              onClick={() => table.nextPage()}
              aria-label="Next page"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
