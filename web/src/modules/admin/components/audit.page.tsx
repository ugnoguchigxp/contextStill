import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type AuditLogActor,
  type AuditLogItem,
  fetchAuditLogs,
} from "../repositories/admin.repository";

const actorOptions: Array<AuditLogActor | "all"> = ["all", "agent", "user", "system"];

function formatAuditDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", { hour12: false });
}

function compactJson(value: Record<string, unknown>, maxChars = 160): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function visiblePageNumbers(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  if (currentPage <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (currentPage >= totalPages - 2) {
    pages.add(totalPages - 3);
    pages.add(totalPages - 2);
    pages.add(totalPages - 1);
  }

  const sortedPages = Array.from(pages)
    .filter((pageNumber) => pageNumber >= 1 && pageNumber <= totalPages)
    .sort((a, b) => a - b);

  return sortedPages.flatMap((pageNumber, index) => {
    const previousPage = sortedPages[index - 1];
    return previousPage && pageNumber - previousPage > 1 ? ["ellipsis", pageNumber] : [pageNumber];
  });
}

export function AuditLogsPage() {
  const [page, setPage] = useState(1);
  const [limit] = useState(100);
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [actorFilter, setActorFilter] = useState<AuditLogActor | "all">("all");
  const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);

  const auditQuery = useQuery({
    queryKey: ["audit-logs", page, limit, eventTypeFilter, actorFilter],
    queryFn: () =>
      fetchAuditLogs({
        page,
        limit,
        eventType: eventTypeFilter === "all" ? undefined : eventTypeFilter,
        actor: actorFilter,
      }),
  });

  const items = auditQuery.data?.items ?? [];

  const columns = useMemo<ColumnDef<AuditLogItem>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "Created At",
        cell: ({ row }) => formatAuditDate(row.original.createdAt),
      },
      {
        accessorKey: "eventType",
        header: "Event Type",
        cell: ({ row }) => (
          <Badge variant="outline" className="font-mono text-[10px]">
            {row.original.eventType}
          </Badge>
        ),
      },
      {
        accessorKey: "actor",
        header: "Actor",
        cell: ({ row }) => (
          <Badge variant="secondary" className="capitalize text-[10px]">
            {row.original.actor}
          </Badge>
        ),
      },
      {
        id: "payload",
        header: "Payload Snippet",
        cell: ({ row }) => (
          <span className="row-subtext font-mono text-[10px] opacity-70">
            {compactJson(row.original.payload, 120)}
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
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const pagination = auditQuery.data?.pagination;
  const currentPage = pagination?.page ?? page;
  const totalPages = Math.max(1, pagination?.totalPages ?? 1);
  const totalAuditCount = pagination?.total ?? items.length;
  const pageLimit = pagination?.limit ?? limit;
  const pageStart = totalAuditCount === 0 ? 0 : (currentPage - 1) * pageLimit + 1;
  const pageEnd = Math.min((currentPage - 1) * pageLimit + items.length, totalAuditCount);
  const canPrev = currentPage > 1;
  const canNext = Boolean(pagination?.hasNextPage);
  const pageNumbers = visiblePageNumbers(currentPage, totalPages);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <section className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-6 py-2">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold">Audit Events</h1>
            <Badge variant="outline" className="bg-background font-mono text-[10px]">
              {totalAuditCount} total
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-transparent bg-muted px-3 py-1">
            <span className="shrink-0 whitespace-nowrap text-[10px] font-bold uppercase text-muted-foreground">
              Event Type
            </span>
            <Select
              aria-label="Event Type"
              value={eventTypeFilter}
              className="h-7 w-[170px] border-0 bg-transparent px-1 py-0 text-xs font-medium shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              onChange={(event) => {
                setEventTypeFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All Events</option>
              {(auditQuery.data?.availableEventTypes ?? []).map((eventType) => (
                <option key={eventType} value={eventType}>
                  {eventType}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-transparent bg-muted px-3 py-1">
            <span className="shrink-0 whitespace-nowrap text-[10px] font-bold uppercase text-muted-foreground">
              Actor
            </span>
            <Select
              aria-label="Actor"
              value={actorFilter}
              className="h-7 w-[110px] border-0 bg-transparent px-1 py-0 text-xs font-medium shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              onChange={(event) => {
                setActorFilter(event.target.value as AuditLogActor | "all");
                setPage(1);
              }}
            >
              {actorOptions.map((actor) => (
                <option key={actor} value={actor}>
                  {actor}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background shadow-sm">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="bg-background px-4 text-xs font-bold uppercase text-muted-foreground"
                  >
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
                      <div>{flexRender(header.column.columnDef.header, header.getContext())}</div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={() => setSelectedLog(row.original)}
                  className="group cursor-pointer transition-colors hover:bg-muted/40"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className="border-b border-muted/30 px-4 py-1.5 text-xs"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-32 text-center text-sm italic text-muted-foreground"
                >
                  No matching audit events found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between border-t bg-background px-6 py-2">
        <div className="text-xs text-muted-foreground">
          Showing <strong>{pageStart}</strong> to <strong>{pageEnd}</strong> of{" "}
          <strong>{totalAuditCount}</strong> items
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!canPrev}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={16} />
            Previous
          </Button>
          <div className="mx-2 flex items-center gap-1">
            {pageNumbers.map((pageNumber, index) =>
              pageNumber === "ellipsis" ? (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: separator positions are derived from page windows
                  key={`audit-page-ellipsis-${index}`}
                  className="px-1 text-xs text-muted-foreground"
                >
                  ...
                </span>
              ) : (
                <button
                  key={`audit-page-${pageNumber}`}
                  type="button"
                  onClick={() => setPage(pageNumber)}
                  className={`h-7 w-7 rounded-md text-xs transition-colors ${
                    currentPage === pageNumber
                      ? "bg-primary font-bold text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {pageNumber}
                </button>
              ),
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!canNext}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
            <ChevronRight size={16} />
          </Button>
        </div>
      </div>

      {/* Inline Modal for Payload Detail */}
      {selectedLog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedLog(null);
            }
          }}
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-card border shadow-2xl rounded-xl overflow-hidden animate-in zoom-in-95 duration-200"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b bg-muted/30">
              <div className="flex items-center gap-3">
                <Badge>{selectedLog.eventType}</Badge>
                <span className="text-sm font-semibold">Event Detail</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 rounded-full"
                aria-label="Close audit event detail"
                onClick={() => setSelectedLog(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-xs bg-muted/20 p-4 rounded-lg border border-muted">
                <div>
                  <span className="text-muted-foreground block mb-1 font-bold uppercase tracking-tighter">
                    Actor
                  </span>
                  <span className="font-semibold">{selectedLog.actor}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-1 font-bold uppercase tracking-tighter">
                    Created At
                  </span>
                  <span className="font-semibold">{formatAuditDate(selectedLog.createdAt)}</span>
                </div>
              </div>
              <div className="space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Raw Payload
                </span>
                <pre className="rounded-lg bg-zinc-950 text-zinc-100 p-5 text-[11px] leading-relaxed font-mono overflow-auto border border-white/10 shadow-inner">
                  {JSON.stringify(selectedLog.payload, null, 2)}
                </pre>
              </div>
            </div>
            <div className="px-6 py-3 border-t bg-muted/10 flex justify-end">
              <Button onClick={() => setSelectedLog(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
