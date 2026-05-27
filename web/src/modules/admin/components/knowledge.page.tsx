import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { asRecord, parseCsvList as parseCsv } from "@/lib/data-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Archive,
  Check,
  Globe,
  Home,
  Plus,
  RotateCcw,
  Search,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  type KnowledgeBulkStatusSelection,
  type KnowledgeItem,
  type KnowledgeListRequest,
  type KnowledgeType,
  type KnowledgeUpdateInput,
  type KnowledgeWriteInput,
  bulkUpdateKnowledgeStatus,
  createKnowledgeItem,
  deleteKnowledgeItem,
  fetchKnowledgeItems,
  sendKnowledgeFeedback,
  updateKnowledgeItem,
} from "../repositories/admin.repository";
import { AdminFilterChipSelect } from "./admin-filter-chip-select";
import { AdminModalShell } from "./admin-modal-shell";
import { AdminPaginationFooter } from "./admin-pagination-footer";
import { AdminSortableTableHead } from "./admin-sortable-table-head";
import {
  useTimezone,
  formatDate as tzFormatDate,
  formatDateTime as tzFormatDateTime,
  formatInTimezone,
} from "@/lib/timezone";

const knowledgeTypes: KnowledgeType[] = ["rule", "procedure"];

const emptyForm: KnowledgeWriteInput = {
  type: "rule",
  status: "draft",
  scope: "repo",
  title: "",
  body: "",
  confidence: 70,
  importance: 70,
  appliesTo: {
    general: false,
  },
  metadata: {},
};

const normalizeKnowledgeType = (type: string): KnowledgeType =>
  knowledgeTypes.includes(type as KnowledgeType) ? (type as KnowledgeType) : "rule";

const qualityScore = (item: Pick<KnowledgeItem, "importance" | "confidence">): number =>
  Math.round(item.importance * 0.6 + item.confidence * 0.4);

const staleDecayThreshold = 0.5;
const highValueThreshold = 60;
const displayFilterOptions = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "deprecated", label: "Deprecated" },
  { value: "unused-active", label: "Unused Active" },
  { value: "stale", label: "Stale" },
  { value: "high-value", label: "High Value" },
] as const;
const serverSelectableStatusFilters = new Set(["all", "draft", "active", "deprecated"]);

function KnowledgeColumnGroup() {
  return (
    <colgroup>
      <col className="w-[4%]" />
      <col className="w-[25%]" />
      <col className="w-[14%]" />
      <col className="w-[6%]" />
      <col className="w-[10%]" />
      <col className="w-[7%]" />
      <col className="w-[7%]" />
      <col className="w-[17%]" />
      <col className="w-[10%]" />
    </colgroup>
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function csvFrom(value: unknown): string {
  return toStringArray(value).join(", ");
}

function summarizeApplicability(appliesTo: unknown): Array<{ label: string; values: string[] }> {
  const record = asRecord(appliesTo);
  const facets: Array<{ label: string; values: string[] }> = [];
  if (record.general === true) {
    facets.push({ label: "general", values: ["true"] });
  }
  const technologies = toStringArray(record.technologies);
  if (technologies.length > 0) {
    facets.push({ label: "tech", values: technologies });
  }
  const changeTypes = toStringArray(record.changeTypes);
  if (changeTypes.length > 0) {
    facets.push({ label: "change", values: changeTypes });
  }
  const domains = toStringArray(record.domains);
  if (domains.length > 0) {
    facets.push({ label: "domain", values: domains });
  }
  return facets;
}

export function KnowledgePage() {
  const tz = useTimezone();
  const formatTimestamp = useCallback(
    (value: string | null): string => {
      if (!value) return "-";
      return formatInTimezone(value, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
    },
    [tz],
  );
  const formatDateTime = useCallback(
    (value: string | null): string => {
      return tzFormatDateTime(value, tz);
    },
    [tz],
  );

  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingOriginalType, setEditingOriginalType] = useState<string | null>(null);
  const [typeChangedInForm, setTypeChangedInForm] = useState(false);
  const [form, setForm] = useState<KnowledgeWriteInput>(emptyForm);
  const [technologiesInput, setTechnologiesInput] = useState("");
  const [changeTypesInput, setChangeTypesInput] = useState("");
  const [domainsInput, setDomainsInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [displayFilter, setDisplayFilter] =
    useState<NonNullable<KnowledgeListRequest["displayFilter"]>>("all");
  const [minQuality, setMinQuality] = useState<number>(0);
  const [searchInputValue, setSearchInputValue] = useState("");
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkSelection, setBulkSelection] = useState<KnowledgeBulkStatusSelection | null>(null);
  const [modalDetail, setModalDetail] = useState<{
    sourceRefs: string[];
    sourceVibeMemoryIds: string[];
    compileSelectCount: number;
    lastCompiledAt: string | null;
    agenticAcceptCount: number;
    explicitUpvoteCount: number;
    explicitDownvoteCount: number;
    dynamicScore: number;
    decayFactor: number;
    lastVerifiedAt: string | null;
    updatedAt: string;
  } | null>(null);

  // TanStack Table states
  const [sorting, setSorting] = useState<SortingState>([{ id: "updatedAt", desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const resetToFirstPage = useCallback(() => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  }, []);
  const serverStatusFilter = ["draft", "active", "deprecated"].includes(displayFilter)
    ? displayFilter
    : undefined;
  const serverSearchQuery = submittedSearchQuery.trim();
  const serverSort = sorting[0] ?? { id: "updatedAt", desc: true };

  const knowledge = useQuery({
    queryKey: [
      "knowledge",
      {
        page: pagination.pageIndex + 1,
        limit: pagination.pageSize,
        status: serverStatusFilter,
        query: serverSearchQuery,
        displayFilter: displayFilter !== "all" ? displayFilter : undefined,
        minQuality: minQuality > 0 ? minQuality : undefined,
        sortBy: serverSort.id,
        sortDir: serverSort.desc ? "desc" : "asc",
      },
    ],
    queryFn: () =>
      fetchKnowledgeItems({
        page: pagination.pageIndex + 1,
        limit: pagination.pageSize,
        status: serverStatusFilter,
        query: serverSearchQuery || undefined,
        displayFilter: displayFilter !== "all" ? displayFilter : undefined,
        minQuality: minQuality > 0 ? minQuality : undefined,
        sortBy: serverSort.id,
        sortDir: serverSort.desc ? "desc" : "asc",
      }),
  });
  const loadedKnowledgeItems = knowledge.data?.items ?? [];
  const totalKnowledgeCount = knowledge.data?.total ?? loadedKnowledgeItems.length;

  useEffect(() => {
    const validIds = new Set(loadedKnowledgeItems.map((item) => item.id));
    setSelectedIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [loadedKnowledgeItems]);

  const buildEditPayload = useCallback((): KnowledgeUpdateInput => {
    const payload: KnowledgeUpdateInput = {
      status: form.status,
      scope: form.scope,
      title: form.title,
      body: form.body,
      confidence: form.confidence,
      importance: form.importance,
      appliesTo: asRecord(form.appliesTo),
      metadata: form.metadata ?? {},
    };
    const originalType = editingOriginalType;
    const canPreserveLegacyType =
      originalType !== null &&
      !knowledgeTypes.includes(originalType as KnowledgeType) &&
      !typeChangedInForm;
    if (!canPreserveLegacyType) {
      payload.type = form.type;
    }
    return payload;
  }, [editingOriginalType, form, typeChangedInForm]);

  const save = useMutation({
    mutationFn: () =>
      editingId ? updateKnowledgeItem(editingId, buildEditPayload()) : createKnowledgeItem(form),
    onSuccess: async () => {
      setForm(emptyForm);
      setEditingId(null);
      setEditingOriginalType(null);
      setTypeChangedInForm(false);
      setModalDetail(null);
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
      setForm(emptyForm);
      setEditingId(null);
      setEditingOriginalType(null);
      setTypeChangedInForm(false);
      setModalDetail(null);
      setError(null);
      setIsModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    },
  });

  const deprecateEditing = useMutation({
    mutationFn: (id: string) =>
      updateKnowledgeItem(id, {
        status: "deprecated",
      }),
    onSuccess: async () => {
      setForm(emptyForm);
      setEditingId(null);
      setEditingOriginalType(null);
      setTypeChangedInForm(false);
      setModalDetail(null);
      setError(null);
      setIsModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    },
  });

  const quickStatusUpdate = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateKnowledgeItem(id, {
        status,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  const quickScopeUpdate = useMutation({
    mutationFn: ({ id, scope }: { id: string; scope: string }) =>
      updateKnowledgeItem(id, {
        scope,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  const bulkStatusUpdate = useMutation({
    mutationFn: (
      input:
        | { ids: string[]; status: "active" | "deprecated" }
        | { selection: KnowledgeBulkStatusSelection; status: "active" | "deprecated" },
    ) => bulkUpdateKnowledgeStatus(input),
    onSuccess: async (result) => {
      setError(
        result.outcome === "partial"
          ? `Bulk update partial: updated=${result.updatedIds.length}, notFound=${result.notFoundIds.length}, invalidTransition=${result.invalidTransitionIds.length}`
          : null,
      );
      if (result.outcome !== "none") {
        setSelectedIds([]);
        setBulkSelection(null);
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
    setEditingOriginalType(item.type);
    setTypeChangedInForm(false);
    setModalDetail({
      sourceRefs: item.sourceRefs ?? [],
      sourceVibeMemoryIds: item.sourceVibeMemoryIds ?? [],
      compileSelectCount: item.compileSelectCount,
      lastCompiledAt: item.lastCompiledAt,
      agenticAcceptCount: item.agenticAcceptCount,
      explicitUpvoteCount: item.explicitUpvoteCount,
      explicitDownvoteCount: item.explicitDownvoteCount,
      dynamicScore: item.dynamicScore,
      decayFactor: item.decayFactor,
      lastVerifiedAt: item.lastVerifiedAt,
      updatedAt: item.updatedAt,
    });
    setForm({
      type: normalizeKnowledgeType(item.type),
      status: item.status,
      scope: item.scope,
      title: item.title,
      body: item.body,
      confidence: item.confidence,
      importance: item.importance,
      appliesTo: asRecord(item.appliesTo),
      metadata: item.metadata ?? {},
    });
    const appliesTo = asRecord(item.appliesTo);
    setTechnologiesInput(csvFrom(appliesTo.technologies));
    setChangeTypesInput(csvFrom(appliesTo.changeTypes));
    setDomainsInput(csvFrom(appliesTo.domains));
    setIsModalOpen(true);
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setEditingOriginalType(null);
    setTypeChangedInForm(false);
    setModalDetail(null);
    setForm(emptyForm);
    setTechnologiesInput("");
    setChangeTypesInput("");
    setDomainsInput("");
    setIsModalOpen(true);
  };

  const deprecateEditingItem = useCallback(() => {
    if (!editingId || form.status === "deprecated") return;
    if (confirm(`Deprecate knowledge item: ${form.title}?`)) {
      deprecateEditing.mutate(editingId);
    }
  }, [deprecateEditing, editingId, form.status, form.title]);

  const deleteEditingItem = useCallback(() => {
    if (!editingId || form.status !== "deprecated") return;
    if (
      confirm(`Delete deprecated knowledge item permanently: ${form.title}? This cannot be undone.`)
    ) {
      remove.mutate(editingId);
    }
  }, [editingId, form.status, form.title, remove]);

  const updateAppliesTo = useCallback((next: Record<string, unknown>) => {
    setForm((current) => ({
      ...current,
      appliesTo: {
        ...asRecord(current.appliesTo),
        ...next,
      },
    }));
  }, []);

  const selectedCount = selectedIds.length;
  const allFilteredIds = useMemo(
    () => loadedKnowledgeItems.map((item) => item.id),
    [loadedKnowledgeItems],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedTotalCount = bulkSelection ? totalKnowledgeCount : selectedCount;
  const visibleSelectedCount = bulkSelection
    ? loadedKnowledgeItems.filter(
        (item) => !bulkSelection.status || bulkSelection.status === item.status,
      ).length
    : allFilteredIds.filter((id) => selectedSet.has(id)).length;
  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setBulkSelection(null);
    setSelectedIds((current) => {
      if (checked) {
        if (current.includes(id)) return current;
        return [...current, id];
      }
      return current.filter((itemId) => itemId !== id);
    });
  }, []);
  const selectAllMatching = useCallback(() => {
    setSelectedIds([]);
    const status = displayFilter === "all" ? undefined : displayFilter;
    setBulkSelection({
      status,
      query: serverSearchQuery || undefined,
    });
  }, [displayFilter, serverSearchQuery]);
  const selectAllDrafts = useCallback(() => {
    setSelectedIds([]);
    setDisplayFilter("draft");
    resetToFirstPage();
    setBulkSelection({
      status: "draft",
      query: serverSearchQuery || undefined,
    });
  }, [resetToFirstPage, serverSearchQuery]);
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setBulkSelection(null);
  }, []);
  const canSelectAllMatching =
    serverSelectableStatusFilters.has(displayFilter) && minQuality === 0 && totalKnowledgeCount > 0;
  const canSelectAllDrafts = minQuality === 0 && totalKnowledgeCount > 0;
  const submitSearch = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const nextQuery = searchInputValue.trim();
      setSubmittedSearchQuery(nextQuery);
      setBulkSelection(null);
      resetToFirstPage();
    },
    [resetToFirstPage, searchInputValue],
  );

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
              checked={
                selectedSet.has(item.id) ||
                (bulkSelection !== null &&
                  (!bulkSelection.status || bulkSelection.status === item.status))
              }
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
          const appliesTo = asRecord(item.appliesTo);
          const technologyBadges = toStringArray(appliesTo.technologies).slice(0, 3);
          const generalBadge = appliesTo.general === true;
          return (
            <div className="knowledge-title-cell">
              <button
                type="button"
                onClick={() => openEdit(item)}
                className="knowledge-title-link text-left font-bold text-blue-600 hover:underline hover:text-blue-700 transition-colors"
                title={item.title}
              >
                {item.title}
              </button>
              <p
                className="knowledge-description-preview row-subtext text-xs opacity-70"
                title={item.body}
              >
                {item.body}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {generalBadge ? (
                  <Badge variant="secondary" className="text-[10px]">
                    general
                  </Badge>
                ) : null}
                {technologyBadges.map((tag) => (
                  <Badge key={`${item.id}-${tag}`} variant="outline" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          );
        },
      },
      {
        id: "appliesTo",
        header: "Applicability",
        cell: ({ row }) => {
          const item = row.original;
          const facets = summarizeApplicability(item.appliesTo);
          if (facets.length === 0) {
            return <span className="text-xs text-muted-foreground">-</span>;
          }
          return (
            <div className="min-w-[210px] space-y-1">
              {facets.map((facet) => {
                const visible = facet.values.slice(0, 2);
                const remaining = facet.values.length - visible.length;
                return (
                  <div key={`${item.id}-${facet.label}`} className="flex items-start gap-1 text-xs">
                    <span className="text-muted-foreground">{facet.label}:</span>
                    <div className="flex flex-wrap gap-1">
                      {visible.map((value) => (
                        <Badge key={`${item.id}-${facet.label}-${value}`} variant="outline">
                          {value}
                        </Badge>
                      ))}
                      {remaining > 0 ? <Badge variant="secondary">+{remaining}</Badge> : null}
                    </div>
                  </div>
                );
              })}
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
                  onClick={() => quickStatusUpdate.mutate({ id: item.id, status: "active" })}
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
                  className="h-6 px-2 text-[10px] gap-1 border-orange-700 text-orange-700 bg-transparent hover:bg-orange-700 hover:text-white hover:border-orange-800"
                  onClick={() => quickStatusUpdate.mutate({ id: item.id, status: "deprecated" })}
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
                  onClick={() => quickStatusUpdate.mutate({ id: item.id, status: "active" })}
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
                quickScopeUpdate.mutate({ id: item.id, scope: isRepo ? "global" : "repo" })
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
            <div className="font-mono text-xs space-y-1 min-w-[160px]">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-muted-foreground">use</span>
                <strong>{item.compileSelectCount}</strong>
                <span className="text-muted-foreground">dyn</span>
                <strong>{item.dynamicScore.toFixed(1)}</strong>
                <span className="text-muted-foreground">decay</span>
                <strong>{item.decayFactor.toFixed(2)}</strong>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-[10px]">
                <Badge variant={isUnusedActive ? "warning" : "secondary"}>unused</Badge>
                <Badge variant={isStale ? "destructive" : "secondary"}>stale</Badge>
                <Badge variant={isHighValue ? "success" : "secondary"}>high value</Badge>
              </div>
              <div className="text-muted-foreground text-[10px] leading-tight">
                compiled {formatTimestamp(item.lastCompiledAt)}
                <br />
                verified {formatTimestamp(item.lastVerifiedAt)}
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
          <div className="text-[11px] text-muted-foreground whitespace-normal break-words [overflow-wrap:anywhere]">
            {formatDateTime(row.getValue("updatedAt"))}
          </div>
        ),
      },
    ],
    [
      feedbackMutation.isPending,
      feedbackMutation.mutate,
      bulkSelection,
      formatDateTime,
      formatTimestamp,
      openEdit,
      quickScopeUpdate.isPending,
      quickScopeUpdate.mutate,
      quickStatusUpdate.isPending,
      quickStatusUpdate.mutate,
      selectedSet,
      toggleSelected,
    ],
  );

  const table = useReactTable({
    data: loadedKnowledgeItems,
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
    pageCount: knowledge.data?.totalPages ?? 0,
    getCoreRowModel: getCoreRowModel(),
  });
  const pageStart = totalKnowledgeCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min(
    pagination.pageIndex * pagination.pageSize + loadedKnowledgeItems.length,
    totalKnowledgeCount,
  );
  const currentPage = pagination.pageIndex + 1;
  const totalPages = knowledge.data?.totalPages ?? 0;
  const displayTotalPages = Math.max(1, totalPages);
  const hasPrev = currentPage > 1;
  const hasNext = totalPages > 0 && currentPage < totalPages;

  return (
    <div className="knowledge-full-layout">
      <section className="knowledge-header">
        <div className="flex items-center gap-4 flex-1 min-w-[280px]">
          <form className="flex w-full max-w-lg items-center gap-2" onSubmit={submitSearch}>
            <Input
              type="search"
              placeholder="Knowledgeを検索..."
              className="h-9"
              value={searchInputValue}
              onChange={(e) => setSearchInputValue(e.target.value)}
            />
            <Button type="submit" size="sm" className="h-9 gap-1.5 whitespace-nowrap">
              <Search size={15} />
              Search
            </Button>
          </form>
        </div>
        <div className="flex items-center gap-3">
          <AdminFilterChipSelect
            label="Filter"
            value={displayFilter}
            className="w-[150px]"
            onChange={(event) => {
              const nextFilter =
                displayFilterOptions.find((option) => option.value === event.target.value)?.value ??
                "all";
              setDisplayFilter(nextFilter);
              setBulkSelection(null);
              resetToFirstPage();
            }}
          >
            {displayFilterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </AdminFilterChipSelect>

          <AdminFilterChipSelect
            label="Quality"
            value={minQuality}
            className="w-[74px]"
            onChange={(event) => {
              setMinQuality(Number(event.target.value));
              setBulkSelection(null);
              resetToFirstPage();
            }}
          >
            <option value="0">All</option>
            <option value="30">30+</option>
            <option value="50">50+</option>
            <option value="70">70+</option>
            <option value="80">80+</option>
            <option value="90">90+</option>
          </AdminFilterChipSelect>

          <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-1">
            <span className="whitespace-nowrap text-[10px] font-bold uppercase text-slate-300">
              Selected {selectedTotalCount} / Visible {visibleSelectedCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={selectedTotalCount === 0 || bulkStatusUpdate.isPending}
              onClick={() => {
                if (confirm(`Activate ${selectedTotalCount} selected knowledge items?`)) {
                  bulkStatusUpdate.mutate(
                    bulkSelection
                      ? { selection: bulkSelection, status: "active" }
                      : { ids: selectedIds, status: "active" },
                  );
                }
              }}
            >
              Activate selected
            </Button>
            {canSelectAllDrafts ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={bulkStatusUpdate.isPending}
                onClick={selectAllDrafts}
              >
                Select all draft
              </Button>
            ) : null}
            {canSelectAllMatching ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={bulkStatusUpdate.isPending}
                onClick={selectAllMatching}
              >
                Select all ({totalKnowledgeCount})
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={selectedTotalCount === 0}
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
        <div className="shrink-0 border-b bg-background shadow-sm">
          <table className="w-full table-fixed caption-bottom text-sm">
            <KnowledgeColumnGroup />
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <AdminSortableTableHead key={header.id} header={header} />
                  ))}
                </TableRow>
              ))}
            </TableHeader>
          </table>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed caption-bottom text-sm">
            <KnowledgeColumnGroup />
            <TableBody>
              {table.getRowModel().rows.map((row) => {
                const item = row.original;
                const rowSelected =
                  selectedSet.has(item.id) ||
                  (bulkSelection !== null &&
                    (!bulkSelection.status || bulkSelection.status === item.status));
                return (
                  <TableRow
                    key={row.id}
                    className={`group hover:bg-muted/50 transition-colors ${rowSelected ? "bg-muted/30" : ""}`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={
                          cell.column.id === "updatedAt"
                            ? "whitespace-normal break-words [overflow-wrap:anywhere]"
                            : undefined
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
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
          </table>
        </div>
      </div>

      <AdminPaginationFooter
        keyPrefix="knowledge"
        currentPage={currentPage}
        totalPages={totalPages}
        canPreviousPage={hasPrev}
        canNextPage={hasNext}
        onPreviousPage={() => table.previousPage()}
        onNextPage={() => table.nextPage()}
        onPageSelect={(pageNumber) => table.setPageIndex(pageNumber - 1)}
        summaryItems={[
          `Showing ${pageStart} to ${pageEnd} of ${totalKnowledgeCount} items | Page ${currentPage} / ${displayTotalPages}`,
        ]}
      />

      {/* Modal / Dialog Overlay */}
      <AdminModalShell
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        ariaLabel={editingId ? "Edit Knowledge" : "Create New Knowledge"}
        title={
          <h2 className="text-lg font-bold">
            {editingId ? "Edit Knowledge" : "Create New Knowledge"}
          </h2>
        }
        overlayClassName="items-start justify-center overflow-y-auto p-4"
        panelClassName="my-4 max-w-2xl max-h-[calc(100vh-2rem)]"
        bodyClassName="p-6"
      >
        <CardContent className="space-y-4 overflow-y-auto p-0">
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
                onChange={(event) => {
                  setTypeChangedInForm(true);
                  setForm({ ...form, type: event.target.value as KnowledgeType });
                }}
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
                onChange={(event) => setForm({ ...form, importance: Number(event.target.value) })}
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
                onChange={(event) => setForm({ ...form, confidence: Number(event.target.value) })}
              />
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold uppercase text-muted-foreground">Applicability</p>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={asRecord(form.appliesTo).general === true}
                  onChange={(event) => updateAppliesTo({ general: event.target.checked })}
                />
                general
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label
                  htmlFor="knowledge-applies-technologies"
                  className="text-[11px] text-muted-foreground"
                >
                  Technologies
                </label>
                <Input
                  id="knowledge-applies-technologies"
                  className="placeholder:text-muted-foreground/60"
                  placeholder="typescript, python"
                  value={technologiesInput}
                  onChange={(event) => {
                    const value = event.target.value;
                    setTechnologiesInput(value);
                    updateAppliesTo({ technologies: parseCsv(value) });
                  }}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="knowledge-applies-change-types"
                  className="text-[11px] text-muted-foreground"
                >
                  Change Types
                </label>
                <Input
                  id="knowledge-applies-change-types"
                  className="placeholder:text-muted-foreground/60"
                  placeholder="feature, bugfix, schema"
                  value={changeTypesInput}
                  onChange={(event) => {
                    const value = event.target.value;
                    setChangeTypesInput(value);
                    updateAppliesTo({ changeTypes: parseCsv(value) });
                  }}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="knowledge-applies-domains"
                  className="text-[11px] text-muted-foreground"
                >
                  Domains
                </label>
                <Input
                  id="knowledge-applies-domains"
                  className="placeholder:text-muted-foreground/60"
                  placeholder="admin-ui, knowledge"
                  value={domainsInput}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDomainsInput(value);
                    updateAppliesTo({ domains: parseCsv(value) });
                  }}
                />
              </div>
            </div>
          </div>
          {editingId ? (
            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <p className="text-xs font-bold uppercase text-muted-foreground">Lifecycle</p>
              {modalDetail ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-center">
                    <span className="block truncate text-[10px] font-semibold uppercase text-muted-foreground">
                      Selected
                    </span>
                    <strong className="block truncate text-xs">
                      {modalDetail.compileSelectCount}
                    </strong>
                  </div>
                  <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-center">
                    <span className="block truncate text-[10px] font-semibold uppercase text-muted-foreground">
                      Accepted
                    </span>
                    <strong className="block truncate text-xs">
                      {modalDetail.agenticAcceptCount}
                    </strong>
                  </div>
                  <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-center">
                    <span className="block truncate text-[10px] font-semibold uppercase text-muted-foreground">
                      Dynamic
                    </span>
                    <strong className="block truncate text-xs">
                      {modalDetail.dynamicScore.toFixed(1)}
                    </strong>
                  </div>
                  <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-center">
                    <span className="block truncate text-[10px] font-semibold uppercase text-muted-foreground">
                      Decay
                    </span>
                    <strong className="block truncate text-xs">
                      {modalDetail.decayFactor.toFixed(2)}
                    </strong>
                  </div>
                  <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-center">
                    <span className="block truncate text-[10px] font-semibold uppercase text-muted-foreground">
                      Feedback
                    </span>
                    <strong className="block truncate text-xs">
                      +{modalDetail.explicitUpvoteCount} / -{modalDetail.explicitDownvoteCount}
                    </strong>
                  </div>
                  <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-center">
                    <span className="block truncate text-[10px] font-semibold uppercase text-muted-foreground">
                      Compiled
                    </span>
                    <strong className="block truncate text-xs">
                      {formatTimestamp(modalDetail.lastCompiledAt)}
                    </strong>
                  </div>
                  <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-center">
                    <span className="block truncate text-[10px] font-semibold uppercase text-muted-foreground">
                      Verified
                    </span>
                    <strong className="block truncate text-xs">
                      {formatTimestamp(modalDetail.lastVerifiedAt)}
                    </strong>
                  </div>
                  <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-center">
                    <span className="block truncate text-[10px] font-semibold uppercase text-muted-foreground">
                      Updated
                    </span>
                    <strong className="block truncate text-xs">
                      {formatTimestamp(modalDetail.updatedAt)}
                    </strong>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">none</p>
              )}
            </div>
          ) : null}
          {editingId ? (
            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <p className="text-xs font-bold uppercase text-muted-foreground">Evidence</p>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">source refs</p>
                {modalDetail && modalDetail.sourceRefs.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-xs">
                    {modalDetail.sourceRefs.map((ref, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: index is appropriate since elements are read-only evidence references
                      <li key={`evidence-ref-${index}`} className="break-all">
                        {ref}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">none</p>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">originating vibe memory</p>
                {modalDetail && modalDetail.sourceVibeMemoryIds.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-xs">
                    {modalDetail.sourceVibeMemoryIds.map((memoryId, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: index is appropriate since elements are read-only evidence memory IDs
                      <li key={`evidence-memory-${index}`}>{memoryId}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">none</p>
                )}
              </div>
            </div>
          ) : null}

          <div className="pt-4 flex items-center justify-between gap-3 border-t">
            <div>
              {editingId ? (
                form.status === "deprecated" ? (
                  <Button
                    variant="destructive"
                    onClick={deleteEditingItem}
                    disabled={remove.isPending}
                    title="Delete permanently"
                  >
                    <Trash2 size={16} />
                    {remove.isPending ? "Deleting..." : "Delete permanently"}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={deprecateEditingItem}
                    disabled={deprecateEditing.isPending}
                    title="Deprecate"
                    className="border-orange-700 bg-orange-700 text-white hover:bg-orange-800 hover:border-orange-800"
                  >
                    <Archive size={16} />
                    {deprecateEditing.isPending ? "Deprecating..." : "Deprecate"}
                  </Button>
                )
              ) : null}
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setIsModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? "Saving..." : editingId ? "Update Item" : "Create Item"}
              </Button>
            </div>
          </div>
          {error ? <p className="text-xs text-destructive text-right mt-2">{error}</p> : null}
        </CardContent>
      </AdminModalShell>
    </div>
  );
}
