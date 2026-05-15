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
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
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
  const selectedLog = useMemo(
    () => items.find((item) => item.id === selectedLogId) ?? null,
    [items, selectedLogId],
  );

  useEffect(() => {
    if (selectedLogId && !items.some((item) => item.id === selectedLogId)) {
      setSelectedLogId(null);
    }
  }, [items, selectedLogId]);

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
          <Badge variant="outline" className="font-mono text-xs">
            {row.original.eventType}
          </Badge>
        ),
      },
      {
        accessorKey: "actor",
        header: "Actor",
        cell: ({ row }) => (
          <Badge variant="secondary" className="capitalize">
            {row.original.actor}
          </Badge>
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
      {/* Fixed Header */}
      <section className="border-b bg-background px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Audit Logs</h1>
            <p className="text-xs text-muted-foreground">重要アクションの時系列ログ（直近7日間）</p>
          </div>
          <Badge variant="outline" className="font-mono">
            {pagination?.total ?? 0} events
          </Badge>
        </div>
      </section>

      <div className="flex flex-1 flex-col overflow-hidden p-6 gap-6">
        {/* Scrollable Table Section */}
        <Card className="flex flex-1 flex-col overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3 border-b bg-muted/30">
            <CardTitle className="text-sm font-semibold">Recent Events</CardTitle>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-[10px] uppercase font-bold text-muted-foreground">
                  Event Type
                </span>
                <Select
                  aria-label="Event Type"
                  value={eventTypeFilter}
                  className="h-7 min-w-[140px] text-xs"
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
                <span className="text-[10px] uppercase font-bold text-muted-foreground">Actor</span>
                <Select
                  aria-label="Actor"
                  value={actorFilter}
                  className="h-7 min-w-[100px] text-xs"
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
              <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur">
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        className={header.column.getCanSort() ? "cursor-pointer select-none" : ""}
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
                      data-state={row.original.id === selectedLogId ? "selected" : undefined}
                      onClick={() => setSelectedLogId(row.original.id)}
                      className="cursor-pointer transition-colors hover:bg-muted/50"
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="py-2 text-xs">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      No audit logs found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="border-t bg-muted/10 px-4 py-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {pagination?.page ?? page} of {Math.max(1, pagination?.totalPages ?? 1)}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={!canPrev}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={!canNext}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </Card>

        {/* Fixed Detail Section at Bottom */}
        <Card className="h-1/3 min-h-[180px] flex flex-col overflow-hidden shrink-0">
          <CardHeader className="py-2 border-b bg-muted/20">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Payload Detail
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto p-3">
            {selectedLog ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 text-[11px] font-medium border-b pb-2">
                  <Badge variant="outline">{selectedLog.eventType}</Badge>
                  <span className="text-muted-foreground">|</span>
                  <span>Actor: {selectedLog.actor}</span>
                  <span className="text-muted-foreground">|</span>
                  <span>{formatAuditDate(selectedLog.createdAt)}</span>
                </div>
                <pre className="rounded-md bg-muted/50 p-4 text-[11px] leading-relaxed font-mono">
                  {JSON.stringify(selectedLog.payload, null, 2)}
                </pre>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground italic">
                イベント行を選択すると詳細を表示します。
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
