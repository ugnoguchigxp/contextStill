import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Globe,
  Home,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  type KnowledgeItem,
  type KnowledgeType,
  type KnowledgeWriteInput,
  bulkUpdateKnowledgeStatus,
  createKnowledgeItem,
  deleteKnowledgeItem,
  fetchKnowledgeItems,
  sendKnowledgeFeedback,
  updateKnowledgeItem,
} from "../repositories/admin.repository";

const knowledgeTypes: KnowledgeType[] = ["rule", "procedure"];

const emptyForm: KnowledgeWriteInput = {
  type: "rule",
  status: "draft",
  scope: "repo",
  title: "",
  body: "",
  confidence: 70,
  importance: 70,
  metadata: {},
};

const normalizeKnowledgeType = (type: string): KnowledgeType =>
  knowledgeTypes.includes(type as KnowledgeType) ? (type as KnowledgeType) : "rule";

const qualityScore = (item: Pick<KnowledgeItem, "importance" | "confidence">): number =>
  Math.round(item.importance * 0.6 + item.confidence * 0.4);

const staleDecayThreshold = 0.5;
const highValueThreshold = 60;

function formatTimestamp(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("ja-JP");
}

export function KnowledgePage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<KnowledgeWriteInput>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [displayFilter, setDisplayFilter] = useState<string>("all");
  const [minQuality, setMinQuality] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedEvidenceId, setExpandedEvidenceId] = useState<string | null>(null);

  // TanStack Table states
  const [sorting, setSorting] = useState<SortingState>([{ id: "updatedAt", desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });

  const knowledge = useQuery({
    queryKey: ["knowledge", 200],
    queryFn: () => fetchKnowledgeItems(200),
  });

  const filteredItems = useMemo(() => {
    const items = knowledge.data ?? [];
    return items.filter((item) => {
      const statusMatch =
        displayFilter === "all" ||
        (displayFilter === "unused-active"
          ? item.status === "active" && item.compileSelectCount === 0
          : displayFilter === "stale"
            ? item.decayFactor < staleDecayThreshold
            : displayFilter === "high-value"
              ? item.dynamicScore >= highValueThreshold
              : item.status === displayFilter);
      const qualityMatch = qualityScore(item) >= minQuality;
      const query = searchQuery.toLowerCase().trim();
      const searchMatch =
        !query ||
        item.title.toLowerCase().includes(query) ||
        item.body.toLowerCase().includes(query);
      return statusMatch && qualityMatch && searchMatch;
    });
  }, [knowledge.data, displayFilter, minQuality, searchQuery]);

  useEffect(() => {
    const validIds = new Set(filteredItems.map((item) => item.id));
    setSelectedIds((current) => current.filter((id) => validIds.has(id)));
    if (expandedEvidenceId && !validIds.has(expandedEvidenceId)) {
      setExpandedEvidenceId(null);
    }
  }, [filteredItems, expandedEvidenceId]);

  const save = useMutation({
    mutationFn: () =>
      editingId ? updateKnowledgeItem(editingId, form) : createKnowledgeItem(form),
    onSuccess: async () => {
      setForm(emptyForm);
      setEditingId(null);
      setError(null);
      setIsModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteKnowledgeItem(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  const quickStatusUpdate = useMutation({
    mutationFn: ({ id, item, status }: { id: string; item: KnowledgeItem; status: string }) =>
      updateKnowledgeItem(id, {
        type: normalizeKnowledgeType(item.type),
        status,
        scope: item.scope,
        title: item.title,
        body: item.body,
        confidence: item.confidence,
        importance: item.importance,
        metadata: item.metadata ?? {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  const quickScopeUpdate = useMutation({
    mutationFn: ({ id, item, scope }: { id: string; item: KnowledgeItem; scope: string }) =>
      updateKnowledgeItem(id, {
        type: normalizeKnowledgeType(item.type),
        status: item.status,
        scope,
        title: item.title,
        body: item.body,
        confidence: item.confidence,
        importance: item.importance,
        metadata: item.metadata ?? {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  const bulkStatusUpdate = useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: "active" | "deprecated" }) =>
      bulkUpdateKnowledgeStatus(ids, status),
    onSuccess: async (result) => {
      setError(
        result.outcome === "partial"
          ? `Bulk update partial: updated=${result.updatedIds.length}, notFound=${result.notFoundIds.length}, invalidTransition=${result.invalidTransitionIds.length}`
          : null,
      );
      if (result.outcome !== "none") {
        setSelectedIds([]);
      }
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    },
  });

  const feedbackMutation = useMutation({
    mutationFn: ({
      id,
      direction,
      reason,
    }: {
      id: string;
      direction: "up" | "down";
      reason?: string;
    }) => sendKnowledgeFeedback(id, { direction, reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["doctor"] });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    },
  });

  const openEdit = useCallback((item: KnowledgeItem) => {
    setEditingId(item.id);
    setForm({
      type: normalizeKnowledgeType(item.type),
      status: item.status,
      scope: item.scope,
      title: item.title,
      body: item.body,
      confidence: item.confidence,
      importance: item.importance,
      metadata: item.metadata ?? {},
    });
    setIsModalOpen(true);
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setIsModalOpen(true);
  };

  const selectedCount = selectedIds.length;
  const allFilteredIds = useMemo(() => filteredItems.map((item) => item.id), [filteredItems]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visibleSelectedCount = allFilteredIds.filter((id) => selectedSet.has(id)).length;
  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelectedIds((current) => {
      if (checked) {
        if (current.includes(id)) return current;
        return [...current, id];
      }
      return current.filter((itemId) => itemId !== id);
    });
  }, []);
  const selectAllFiltered = useCallback(() => {
    setSelectedIds(allFilteredIds);
  }, [allFilteredIds]);
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  const columns = useMemo<ColumnDef<KnowledgeItem>[]>(
    () => [
      {
        id: "select",
        header: "Select",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <input
              type="checkbox"
              checked={selectedSet.has(item.id)}
              onChange={(event) => toggleSelected(item.id, event.target.checked)}
              aria-label={`select-${item.id}`}
            />
          );
        },
      },
      {
        accessorKey: "title",
        header: "Title & Description",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="max-w-md">
              <button
                type="button"
                onClick={() => openEdit(item)}
                className="text-left font-bold text-blue-600 hover:underline hover:text-blue-700 transition-colors block mb-1"
              >
                {item.title}
              </button>
              <p className="row-subtext line-clamp-2 text-xs opacity-70">{item.body}</p>
              <button
                type="button"
                className="mt-1 text-[11px] text-cyan-400 hover:text-cyan-300"
                onClick={() =>
                  setExpandedEvidenceId((current) => (current === item.id ? null : item.id))
                }
              >
                {expandedEvidenceId === item.id ? "Hide evidence" : "Show evidence"}
              </button>
            </div>
          );
        },
      },
      {
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => {
          const type = row.getValue("type") as string;
          return knowledgeTypes.includes(type as KnowledgeType) ? (
            <Badge variant="outline" className="capitalize">
              {type}
            </Badge>
          ) : (
            <Badge variant="warning">legacy: {type}</Badge>
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  item.status === "active"
                    ? "success"
                    : item.status === "deprecated"
                      ? "destructive"
                      : "secondary"
                }
                className="capitalize"
              >
                {item.status}
              </Badge>

              {item.status === "draft" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px] gap-1 hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200"
                  onClick={() => quickStatusUpdate.mutate({ id: item.id, item, status: "active" })}
                  disabled={quickStatusUpdate.isPending}
                  title="Promote to Active"
                >
                  <Check size={12} />
                  Active
                </Button>
              )}

              {item.status === "active" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px] gap-1 hover:bg-red-50 hover:text-red-600 hover:border-red-200"
                  onClick={() =>
                    quickStatusUpdate.mutate({ id: item.id, item, status: "deprecated" })
                  }
                  disabled={quickStatusUpdate.isPending}
                  title="Deprecate"
                >
                  <Archive size={12} />
                  Deprecate
                </Button>
              )}

              {item.status === "deprecated" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px] gap-1 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200"
                  onClick={() => quickStatusUpdate.mutate({ id: item.id, item, status: "active" })}
                  disabled={quickStatusUpdate.isPending}
                  title="Restore to Active"
                >
                  <RotateCcw size={12} />
                  Restore
                </Button>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "scope",
        header: "Scope",
        cell: ({ row }) => {
          const item = row.original;
          const isRepo = item.scope === "repo";
          return (
            <Button
              variant="outline"
              size="sm"
              className={`h-7 px-2 text-[10px] uppercase font-bold gap-1.5 transition-all ${
                isRepo
                  ? "border-slate-200 text-slate-500 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200"
                  : "border-amber-200 text-amber-600 bg-amber-50 hover:bg-amber-100"
              }`}
              onClick={() =>
                quickScopeUpdate.mutate({ id: item.id, item, scope: isRepo ? "global" : "repo" })
              }
              disabled={quickScopeUpdate.isPending}
            >
              {isRepo ? <Home size={12} /> : <Globe size={12} />}
              {item.scope}
            </Button>
          );
        },
      },
      {
        id: "qualityScore",
        accessorFn: (item) => qualityScore(item),
        header: "Quality",
        cell: ({ row }) => {
          const item = row.original;
          const score = qualityScore(item);
          return (
            <div className="font-mono text-xs leading-tight">
              <div className="font-bold text-slate-100">{score}</div>
              <div className="text-muted-foreground">
                I:<span className="text-blue-500">{Math.round(item.importance)}</span>
                {" / "}
                C:<span className="text-emerald-500">{Math.round(item.confidence)}</span>
              </div>
            </div>
          );
        },
      },
      {
        id: "lifecycle",
        header: "Lifecycle",
        cell: ({ row }) => {
          const item = row.original;
          const isStale = item.decayFactor < staleDecayThreshold;
          const isHighValue = item.dynamicScore >= highValueThreshold;
          const isUnusedActive = item.status === "active" && item.compileSelectCount === 0;
          return (
            <div className="font-mono text-xs space-y-1 min-w-[220px]">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">use</span>
                <strong>{item.compileSelectCount}</strong>
                <span className="text-muted-foreground">dyn</span>
                <strong>{item.dynamicScore.toFixed(1)}</strong>
                <span className="text-muted-foreground">decay</span>
                <strong>{item.decayFactor.toFixed(2)}</strong>
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <Badge variant={isUnusedActive ? "warning" : "secondary"}>unused</Badge>
                <Badge variant={isStale ? "destructive" : "secondary"}>stale</Badge>
                <Badge variant={isHighValue ? "success" : "secondary"}>high value</Badge>
              </div>
              <div className="text-muted-foreground">
                compiled {formatTimestamp(item.lastCompiledAt)} / verified{" "}
                {formatTimestamp(item.lastVerifiedAt)}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-6 w-6"
                  title="Upvote"
                  disabled={feedbackMutation.isPending}
                  onClick={() => feedbackMutation.mutate({ id: item.id, direction: "up" })}
                >
                  <ThumbsUp size={12} />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-6 w-6"
                  title="Downvote"
                  disabled={feedbackMutation.isPending}
                  onClick={() => feedbackMutation.mutate({ id: item.id, direction: "down" })}
                >
                  <ThumbsDown size={12} />
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  +{item.explicitUpvoteCount} / -{item.explicitDownvoteCount}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground">
            {new Date(row.getValue("updatedAt")).toLocaleDateString("ja-JP")}
          </div>
        ),
      },
      {
        id: "actions",
        header: () => <div className="text-right">Actions</div>,
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="icon" onClick={() => openEdit(item)} title="Edit">
                <Pencil size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:bg-destructive/10"
                onClick={() => {
                  if (confirm(`Delete knowledge item: ${item.title}?`)) {
                    remove.mutate(item.id);
                  }
                }}
                title="Delete"
              >
                <Trash2 size={16} />
              </Button>
            </div>
          );
        },
      },
    ],
    [
      expandedEvidenceId,
      feedbackMutation.isPending,
      feedbackMutation.mutate,
      openEdit,
      quickScopeUpdate.isPending,
      quickScopeUpdate.mutate,
      quickStatusUpdate.isPending,
      quickStatusUpdate.mutate,
      remove.mutate,
      selectedSet,
      toggleSelected,
    ],
  );

  const table = useReactTable({
    data: filteredItems,
    columns,
    state: {
      sorting,
      pagination,
    },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <div className="knowledge-full-layout">
      <section className="knowledge-header">
        <div className="flex items-center gap-4 flex-1">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Knowledgeを検索..."
              className="pl-9 h-9"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex bg-muted rounded-lg p-1">
            {["all", "draft", "active", "deprecated", "unused-active", "stale", "high-value"].map(
              (f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setDisplayFilter(f)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                    displayFilter === f
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="capitalize">{f.replace("-", " ")}</span>
                </button>
              ),
            )}
          </div>

          <div className="flex items-center gap-2 px-3 py-1 bg-muted rounded-lg border border-transparent">
            <span className="text-[10px] font-bold uppercase text-muted-foreground">Quality</span>
            <select
              value={minQuality}
              onChange={(e) => setMinQuality(Number(e.target.value))}
              className="bg-transparent text-xs font-medium outline-none cursor-pointer"
            >
              <option value="0">All</option>
              <option value="30">30+</option>
              <option value="50">50+</option>
              <option value="70">70+</option>
              <option value="80">80+</option>
              <option value="90">90+</option>
            </select>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-1">
            <span className="text-[10px] font-bold uppercase text-slate-300">
              Selected {selectedCount} / Visible {visibleSelectedCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={selectedCount === 0 || bulkStatusUpdate.isPending}
              onClick={() => {
                if (confirm(`Activate ${selectedCount} selected knowledge items?`)) {
                  bulkStatusUpdate.mutate({ ids: selectedIds, status: "active" });
                }
              }}
            >
              Activate selected
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] border-red-300 text-red-300 hover:bg-red-900/30"
              disabled={selectedCount === 0 || bulkStatusUpdate.isPending}
              onClick={() => {
                if (confirm(`Deprecate ${selectedCount} selected knowledge items?`)) {
                  bulkStatusUpdate.mutate({ ids: selectedIds, status: "deprecated" });
                }
              }}
            >
              Deprecate selected
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={allFilteredIds.length === 0}
              onClick={selectAllFiltered}
            >
              Select filtered ({allFilteredIds.length})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={selectedCount === 0}
              onClick={clearSelection}
            >
              Clear
            </Button>
          </div>

          <Button onClick={openCreate} className="gap-2">
            <Plus size={18} />
            Create New
          </Button>
        </div>
      </section>

      <div className="knowledge-table-container">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background shadow-sm">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="flex items-center gap-2 cursor-pointer select-none hover:text-foreground transition-colors"
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
            {table.getRowModel().rows.map((row) => {
              const item = row.original;
              const rowSelected = selectedSet.has(item.id);
              const sourceRefs = item.sourceRefs ?? [];
              const sourceVibeMemoryIds = item.sourceVibeMemoryIds ?? [];
              return (
                <Fragment key={row.id}>
                  <TableRow
                    className={`group hover:bg-muted/50 transition-colors ${rowSelected ? "bg-muted/30" : ""}`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expandedEvidenceId === item.id ? (
                    <TableRow className="bg-slate-900/20">
                      <TableCell colSpan={columns.length}>
                        <div className="space-y-2 text-xs">
                          <p className="font-semibold text-slate-200">Evidence</p>
                          <div>
                            <p className="text-muted-foreground">source refs</p>
                            {sourceRefs.length > 0 ? (
                              <ul className="list-disc pl-4">
                                {sourceRefs.map((ref) => (
                                  <li key={`${item.id}-${ref}`} className="break-all">
                                    {ref}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-muted-foreground">none</p>
                            )}
                          </div>
                          <div>
                            <p className="text-muted-foreground">originating vibe memory</p>
                            {sourceVibeMemoryIds.length > 0 ? (
                              <ul className="list-disc pl-4">
                                {sourceVibeMemoryIds.map((memoryId) => (
                                  <li key={`${item.id}-${memoryId}`}>{memoryId}</li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-muted-foreground">none</p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
            {table.getRowModel().rows.length === 0 && !knowledge.isLoading && (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center py-20 text-muted-foreground"
                >
                  knowledge itemはまだありません。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Controls */}
      <div className="flex items-center justify-between px-6 py-3 border-t bg-background">
        <div className="text-xs text-muted-foreground">
          Showing{" "}
          <strong>
            {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}
          </strong>{" "}
          to{" "}
          <strong>
            {Math.min(
              (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
              filteredItems.length,
            )}
          </strong>{" "}
          of <strong>{filteredItems.length}</strong> items
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="gap-1"
          >
            <ChevronLeft size={16} />
            Previous
          </Button>
          <div className="flex items-center gap-1 mx-2">
            {Array.from({ length: table.getPageCount() }, (_, i) => (
              <button
                key={`page-${i + 1}`}
                type="button"
                onClick={() => table.setPageIndex(i)}
                className={`w-7 h-7 text-xs rounded-md transition-colors ${
                  table.getState().pagination.pageIndex === i
                    ? "bg-primary text-primary-foreground font-bold"
                    : "hover:bg-muted text-muted-foreground"
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="gap-1"
          >
            Next
            <ChevronRight size={16} />
          </Button>
        </div>
      </div>

      {/* Modal / Dialog Overlay */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <Card className="w-full max-w-2xl shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h2 className="text-lg font-bold">
                {editingId ? "Edit Knowledge" : "Create New Knowledge"}
              </h2>
              <Button variant="ghost" size="icon" onClick={() => setIsModalOpen(false)}>
                <X size={20} />
              </Button>
            </div>
            <CardContent className="p-6 space-y-4">
              <div className="space-y-1">
                <label
                  htmlFor="knowledge-title"
                  className="text-xs font-bold uppercase text-muted-foreground"
                >
                  Title
                </label>
                <Input
                  id="knowledge-title"
                  placeholder="title"
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="knowledge-body"
                  className="text-xs font-bold uppercase text-muted-foreground"
                >
                  Body Content
                </label>
                <Textarea
                  id="knowledge-body"
                  placeholder="body"
                  className="min-h-[200px]"
                  value={form.body}
                  onChange={(event) => setForm({ ...form, body: event.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="knowledge-type"
                    className="text-xs font-bold uppercase text-muted-foreground"
                  >
                    Type
                  </label>
                  <Select
                    id="knowledge-type"
                    value={form.type}
                    onChange={(event) =>
                      setForm({ ...form, type: event.target.value as KnowledgeType })
                    }
                  >
                    {knowledgeTypes.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="knowledge-status"
                    className="text-xs font-bold uppercase text-muted-foreground"
                  >
                    Status
                  </label>
                  <Select
                    id="knowledge-status"
                    value={form.status}
                    onChange={(event) => setForm({ ...form, status: event.target.value })}
                  >
                    {["draft", "active", "deprecated"].map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="knowledge-scope"
                    className="text-xs font-bold uppercase text-muted-foreground"
                  >
                    Scope
                  </label>
                  <Select
                    id="knowledge-scope"
                    value={form.scope}
                    onChange={(event) => setForm({ ...form, scope: event.target.value })}
                  >
                    {["repo", "global"].map((scope) => (
                      <option key={scope} value={scope}>
                        {scope}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="knowledge-importance"
                    className="text-xs font-bold uppercase text-muted-foreground"
                  >
                    Importance (0-100)
                  </label>
                  <Input
                    id="knowledge-importance"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={form.importance}
                    onChange={(event) =>
                      setForm({ ...form, importance: Number(event.target.value) })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="knowledge-confidence"
                    className="text-xs font-bold uppercase text-muted-foreground"
                  >
                    Confidence (0-100)
                  </label>
                  <Input
                    id="knowledge-confidence"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={form.confidence}
                    onChange={(event) =>
                      setForm({ ...form, confidence: Number(event.target.value) })
                    }
                  />
                </div>
              </div>

              <div className="pt-4 flex justify-end gap-3 border-t">
                <Button variant="outline" onClick={() => setIsModalOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving..." : editingId ? "Update Item" : "Create Item"}
                </Button>
              </div>
              {error ? <p className="text-xs text-destructive text-right mt-2">{error}</p> : null}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
