import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime as tzFormatDateTime, useTimezone } from "@/lib/timezone";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  type CandidateListItem,
  type CandidateListStats,
  type CandidateOutcome,
  type CandidateListSortBy,
  fetchCandidateItems,
} from "../repositories/admin.repository";
import { AdminPaginationFooter } from "./admin-pagination-footer";
import { AdminSortableTableHead } from "./admin-sortable-table-head";
import {
  CandidateColumnGroup,
  CandidateDetailPane,
  compactBadgeClass,
  coverageBadge,
  initialTargetStateIdFromLocation,
  landscapeWarningSummary,
  nextCandidateAction,
  outcomeBadge,
  outcomeLabel,
  tableCellClass,
  tableHeadClass,
  textPreview,
} from "./candidates.page.shared";

const candidateViewOptions: Array<{
  value: "all" | CandidateOutcome;
  label: string;
  count: (stats: CandidateListStats | undefined) => number;
}> = [
  { value: "all", label: "All active", count: (stats) => stats?.total ?? 0 },
  {
    value: "ready_not_finalized",
    label: "Ready to store",
    count: (stats) => stats?.readyNotFinalized ?? 0,
  },
  {
    value: "retained_failure",
    label: "Failed",
    count: (stats) => stats?.retainedFailure ?? 0,
  },
  { value: "rejected", label: "Rejected", count: (stats) => stats?.rejected ?? 0 },
  { value: "retryable", label: "Retryable", count: (stats) => stats?.retryable ?? 0 },
  { value: "target_pending", label: "Pending", count: (stats) => stats?.targetPending ?? 0 },
  { value: "candidate_only", label: "Uncovered", count: (stats) => stats?.candidateOnly ?? 0 },
];

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
  >("knowledge_candidate");
  const [targetStateIdFilter, setTargetStateIdFilter] = useState(initialTargetStateIdFromLocation);
  const [outcome, setOutcome] = useState<"all" | CandidateOutcome>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const resetToFirstPage = useCallback(() => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
    setSelectedId(null);
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
        sortBy: serverSort.id as CandidateListSortBy,
        sortDir: serverSort.desc ? "desc" : "asc",
      }),
    refetchInterval: 5000,
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
  const drawerItem = selectedId ? items.find((item) => item.id === selectedId) : null;

  const columns = useMemo<ColumnDef<CandidateListItem>[]>(
    () => [
      {
        id: "candidateTitle",
        accessorFn: (item) => item.original.title,
        header: "Candidate",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <Badge variant={outcomeBadge(item.outcome)} className={compactBadgeClass}>
                  {outcomeLabel(item.outcome)}
                </Badge>
                {item.landscapeWarning ? (
                  <Badge variant="warning" className={compactBadgeClass}>
                    <AlertTriangle size={11} className="mr-1" />
                    warning
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs font-semibold break-words [overflow-wrap:anywhere]">
                {item.original.title}
              </p>
              <p className="text-[11px] text-muted-foreground break-words [overflow-wrap:anywhere]">
                {textPreview(item.original.body, 120)}
              </p>
            </div>
          );
        },
      },
      {
        id: "targetKey",
        accessorFn: (item) => item.targetKey,
        header: "Source",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="min-w-0 space-y-1">
              <Badge variant="outline" className={compactBadgeClass}>
                {item.targetKind}
              </Badge>
              <p className="text-xs font-medium break-words [overflow-wrap:anywhere]">
                {item.targetKey}
              </p>
            </div>
          );
        },
      },
      {
        id: "outcome",
        accessorFn: (item) => item.outcome,
        header: "State",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="min-w-0 space-y-1 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground">{outcomeLabel(item.outcome)}</p>
              <p className="break-words [overflow-wrap:anywhere]">
                {item.targetStatus} / {item.targetPhase}
              </p>
            </div>
          );
        },
      },
      {
        id: "coverageStatus",
        accessorFn: (item) => item.cover?.status ?? "",
        header: "Evidence",
        cell: ({ row }) => {
          const item = row.original;
          return item.cover ? (
            <div className="min-w-0 space-y-1">
              <Badge variant={coverageBadge(item.cover.status)} className={compactBadgeClass}>
                {item.cover.status}
              </Badge>
              <p className="text-[11px] text-muted-foreground break-words [overflow-wrap:anywhere]">
                {textPreview(item.cover.reason ?? item.cover.stage, 80)}
              </p>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">no cover result</span>
          );
        },
      },
      {
        id: "nextAction",
        header: "Next action",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-[11px] font-medium text-muted-foreground break-words [overflow-wrap:anywhere]">
            {nextCandidateAction(row.original)}
          </span>
        ),
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
          <div className="grid grid-cols-1 items-center gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search source / candidate / evidence"
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
              <option value="knowledge_candidate">knowledge_candidate</option>
              <option value="all">all target kinds</option>
              <option value="wiki_file">wiki_file</option>
              <option value="web_ingest">web_ingest</option>
              <option value="vibe_memory">vibe_memory</option>
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
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            {candidateViewOptions.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={outcome === option.value ? "default" : "outline"}
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setOutcome(option.value);
                  resetToFirstPage();
                }}
              >
                <span>{option.label}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {option.count(stats)}
                </span>
              </Button>
            ))}
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

        <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
          {candidatesQuery.isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading candidates...
            </div>
          ) : null}
          {!candidatesQuery.isLoading && candidatesQuery.isError ? (
            <div className="flex h-full items-center justify-center text-sm text-destructive">
              Failed to load candidates.
            </div>
          ) : null}
          {!candidatesQuery.isLoading && !candidatesQuery.isError && items.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No candidates found.
            </div>
          ) : null}
          {!candidatesQuery.isLoading && !candidatesQuery.isError && items.length > 0 ? (
            <>
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
                    {table.getRowModel().rows.map((row) => {
                      const item = row.original;
                      return (
                        <TableRow
                          key={item.id}
                          className="cursor-pointer hover:bg-muted/30"
                          onClick={() => setSelectedId(item.id)}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id} className={tableCellClass}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        <AdminPaginationFooter
          keyPrefix="candidate"
          currentPage={currentPage}
          totalPages={totalPages}
          canPreviousPage={hasPrev}
          canNextPage={hasNext}
          onPreviousPage={() => {
            table.previousPage();
            setSelectedId(null);
          }}
          onNextPage={() => {
            table.nextPage();
            setSelectedId(null);
          }}
          onPageSelect={(pageNumber) => {
            table.setPageIndex(pageNumber - 1);
            setSelectedId(null);
          }}
          summaryItems={[
            `Showing ${pageStart} to ${pageEnd} of ${total} candidates | Page ${currentPage} / ${displayTotalPages}`,
            `active ${stats?.total ?? 0} | ready ${stats?.readyNotFinalized ?? 0} | failed ${stats?.retainedFailure ?? 0} | rejected ${stats?.rejected ?? 0} | retryable ${stats?.retryable ?? 0} | pending ${stats?.targetPending ?? 0}`,
            `retained failures ${stats?.retainedFailure ?? 0}`,
          ]}
        />
        {drawerItem ? (
          <CandidateDrawer
            item={drawerItem}
            formatDate={formatDate}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </Card>
    </div>
  );
}

function CandidateDrawer({
  item,
  formatDate,
  onClose,
}: {
  item: CandidateListItem;
  formatDate: (value: string | Date | null | undefined) => string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/25" role="presentation">
      <button
        type="button"
        aria-label="Close candidate details backdrop"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <aside
        aria-label="Candidate details"
        className="relative z-10 h-full w-full max-w-3xl overflow-auto border-l bg-background p-4 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Candidate details
            </p>
            <h2 className="mt-1 text-lg font-semibold break-words [overflow-wrap:anywhere]">
              {item.original.title}
            </h2>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="grid gap-4">
          <div className="rounded-md border bg-background p-4">
            <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant={outcomeBadge(item.outcome)}>{outcomeLabel(item.outcome)}</Badge>
              <Badge variant="outline">{item.targetKind}</Badge>
              {item.cover ? (
                <Badge variant={coverageBadge(item.cover.status)}>{item.cover.status}</Badge>
              ) : (
                <Badge variant="secondary">no cover result</Badge>
              )}
            </div>
            <h2 className="text-lg font-semibold break-words [overflow-wrap:anywhere]">
              {item.original.title}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
              {item.original.body}
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,0.55fr)_minmax(0,0.45fr)]">
            <div className="rounded-md border bg-background p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Next action
              </p>
              <p className="mt-2 text-sm font-semibold">{nextCandidateAction(item)}</p>
              <p className="mt-2 text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
                {item.cover?.reason ?? item.targetLastError ?? "No blocking reason recorded."}
              </p>
            </div>
            <div className="rounded-md border bg-background p-4 text-xs text-muted-foreground">
              <p className="font-semibold uppercase tracking-wide">Source</p>
              <p className="mt-2 break-words [overflow-wrap:anywhere]">{item.targetKey}</p>
              <p className="mt-2">updated: {formatDate(item.latestUpdatedAt)}</p>
              <p>
                pipeline: {item.targetStatus} / {item.targetPhase}
              </p>
            </div>
          </div>

          {item.landscapeWarning ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle size={16} />
                Landscape warning
              </div>
              <p className="mt-2 text-xs break-words [overflow-wrap:anywhere]">
                {landscapeWarningSummary(item) ?? "manual approval required"}
              </p>
            </div>
          ) : null}

          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
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
          </div>

          <details className="rounded-md border bg-background p-4 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-semibold uppercase tracking-wide">
              Debug metadata
            </summary>
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                <p>targetStateId: {item.targetStateId}</p>
                <p>findCandidateResultId: {item.id}</p>
                <p>coverEvidenceResultId: {item.id}</p>
                <p>knowledgeId: {item.knowledge?.id ?? "-"}</p>
                <p>candidateIndex: {item.candidateIndex}</p>
              </div>
              <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                <p>sourceUri: {item.sourceUri}</p>
                <p>finalizeSourceUri: {item.finalizeSourceUri}</p>
                <p>references: {item.cover?.referencesCount ?? 0}</p>
                <p>duplicateRefs: {item.cover?.duplicateRefsCount ?? 0}</p>
                <p>toolEvents: {item.cover?.toolEventsCount ?? 0}</p>
              </div>
            </div>
          </details>
        </div>
      </aside>
    </div>
  );
}
