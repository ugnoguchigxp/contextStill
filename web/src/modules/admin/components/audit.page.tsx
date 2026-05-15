import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchAuditLogs,
  type AuditLogActor,
  type AuditLogItem,
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
  const canPrev = (pagination?.page ?? 1) > 1;
  const canNext = Boolean(pagination?.hasNextPage);

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden bg-background">
      {/* Full-screen Card Container */}
      <Card className="flex flex-1 flex-col overflow-hidden rounded-none border-0 shadow-none">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4 px-6 border-b bg-muted/20">
          <div className="flex items-center gap-4">
            <CardTitle className="text-base font-bold">Audit Events</CardTitle>
            <Badge variant="outline" className="font-mono text-[10px] bg-background">
              {pagination?.total ?? 0} total
            </Badge>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground whitespace-nowrap shrink-0">
                Event Type
              </span>
              <Select
                aria-label="Event Type"
                value={eventTypeFilter}
                className="h-8 min-w-[160px] text-xs bg-background"
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
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground whitespace-nowrap shrink-0">
                Actor
              </span>
              <Select
                aria-label="Actor"
                value={actorFilter}
                className="h-8 min-w-[110px] text-xs bg-background"
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
        </CardHeader>
        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b shadow-sm">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={header.column.getCanSort() ? "cursor-pointer select-none px-6" : "px-6"}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center gap-2">
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
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
                    className="cursor-pointer transition-colors hover:bg-muted/40 group"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="py-2.5 px-6 text-xs border-b border-muted/30">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="h-32 text-center text-sm text-muted-foreground italic">
                    No matching audit events found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="border-t bg-muted/5 px-6 py-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing Page {pagination?.page ?? page} of {Math.max(1, pagination?.totalPages ?? 1)}
          </span>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              disabled={!canPrev}
              onClick={(e) => { e.stopPropagation(); setPage(page - 1); }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              disabled={!canNext}
              onClick={(e) => { e.stopPropagation(); setPage(page + 1); }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>

      {/* Inline Modal for Payload Detail */}
      {selectedLog && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setSelectedLog(null)}
        >
          <div 
            className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-card border shadow-2xl rounded-xl overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
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
                onClick={() => setSelectedLog(null)}
              >
                ✕
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-xs bg-muted/20 p-4 rounded-lg border border-muted">
                <div>
                  <span className="text-muted-foreground block mb-1 font-bold uppercase tracking-tighter">Actor</span>
                  <span className="font-semibold">{selectedLog.actor}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-1 font-bold uppercase tracking-tighter">Created At</span>
                  <span className="font-semibold">{formatAuditDate(selectedLog.createdAt)}</span>
                </div>
              </div>
              <div className="space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Raw Payload</span>
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
