import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, useTimezone } from "@/lib/timezone";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type ReactNode, useMemo, useState } from "react";
import {
  type AuditLogActor,
  type AuditLogItem,
  fetchAuditLogs,
} from "../repositories/admin.repository";
import { AdminFilterChipSelect } from "./admin-filter-chip-select";
import { AdminModalShell } from "./admin-modal-shell";
import { AdminPaginationFooter } from "./admin-pagination-footer";
import { AdminSortableTableHead } from "./admin-sortable-table-head";

const actorOptions: Array<AuditLogActor | "all"> = ["all", "agent", "user", "system"];

function compactJson(value: Record<string, unknown>, maxChars = 160): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function eventTypeOptions(eventTypes: string[]): ReactNode[] {
  return [
    <option key="audit-event-type-all" value="all">
      All Events
    </option>,
    ...eventTypes.map((eventType) => (
      <option key={eventType} value={eventType}>
        {eventType}
      </option>
    )),
  ];
}

export function AuditLogsPage() {
  const timezone = useTimezone();
  const initialQueryText = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  }, []);
  const [page, setPage] = useState(1);
  const [limit] = useState(100);
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [actorFilter, setActorFilter] = useState<AuditLogActor | "all">("all");
  const [queryText, setQueryText] = useState(initialQueryText);
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

  const queryNeedle = queryText.trim().toLowerCase();
  const items = (auditQuery.data?.items ?? []).filter((item) => {
    if (!queryNeedle) return true;
    return [item.id, item.eventType, item.actor, JSON.stringify(item.payload)]
      .join("\n")
      .toLowerCase()
      .includes(queryNeedle);
  });

  const columns = useMemo<ColumnDef<AuditLogItem>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "Created At",
        cell: ({ row }) => formatDateTime(row.original.createdAt, timezone),
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
    [timezone],
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
          <Input
            className="h-8 w-[220px]"
            value={queryText}
            onChange={(event) => {
              setQueryText(event.target.value);
              setPage(1);
            }}
            placeholder="Search payload"
          />
          <AdminFilterChipSelect
            label="Event Type"
            aria-label="Event Type"
            value={eventTypeFilter}
            className="w-[170px]"
            onChange={(event) => {
              setEventTypeFilter(event.target.value);
              setPage(1);
            }}
          >
            {eventTypeOptions(auditQuery.data?.availableEventTypes ?? [])}
          </AdminFilterChipSelect>
          <AdminFilterChipSelect
            label="Actor"
            aria-label="Actor"
            value={actorFilter}
            className="w-[110px]"
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
          </AdminFilterChipSelect>
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background shadow-sm">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <AdminSortableTableHead
                    key={header.id}
                    header={header}
                    className="bg-background px-4 text-xs font-bold uppercase text-muted-foreground"
                  />
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

      <AdminPaginationFooter
        keyPrefix="audit"
        currentPage={currentPage}
        totalPages={totalPages}
        canPreviousPage={canPrev}
        canNextPage={canNext}
        onPreviousPage={() => setPage(currentPage - 1)}
        onNextPage={() => setPage(currentPage + 1)}
        onPageSelect={(pageNumber) => setPage(pageNumber)}
        summaryItems={[
          `Showing ${pageStart} to ${pageEnd} of ${totalAuditCount} items | Page ${currentPage} / ${totalPages}`,
        ]}
      />

      {/* Inline Modal for Payload Detail */}
      <AdminModalShell
        isOpen={selectedLog !== null}
        onClose={() => setSelectedLog(null)}
        closeOnBackdrop
        closeAriaLabel="Close audit event detail"
        ariaLabel={
          selectedLog ? `Audit event detail for ${selectedLog.eventType}` : "Audit event detail"
        }
        title={<span className="text-sm font-semibold">Event Detail</span>}
        headerLeading={selectedLog ? <Badge>{selectedLog.eventType}</Badge> : undefined}
        overlayClassName="animate-in fade-in duration-200"
        panelClassName="max-w-3xl rounded-xl"
        headerClassName="bg-muted/30"
        bodyClassName="flex-1 p-6 space-y-4"
      >
        {selectedLog ? (
          <>
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-muted bg-muted/20 p-4 text-xs">
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
                <span className="font-semibold">
                  {formatDateTime(selectedLog.createdAt, timezone)}
                </span>
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Raw Payload
              </span>
              <pre className="rounded-lg bg-zinc-950 p-5 text-[11px] leading-relaxed font-mono text-zinc-100 overflow-auto border border-white/10 shadow-inner">
                {JSON.stringify(selectedLog.payload, null, 2)}
              </pre>
            </div>
            <div className="flex justify-end border-t bg-muted/10 px-0 py-3">
              <Button onClick={() => setSelectedLog(null)}>Close</Button>
            </div>
          </>
        ) : null}
      </AdminModalShell>
    </div>
  );
}
