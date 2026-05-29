import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Activity,
  CircleCheck,
  Cpu,
  Gem,
  Mail,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { AdminPageHeader } from "./admin-page-header";
import { AdminSortableTableHead } from "./admin-sortable-table-head";
import {
  fetchActiveQueueTasksV2,
  fetchQueueDashboardStatsV2,
  fetchQueueItemsV2,
  pauseQueueLaneV2,
  pauseQueueJobV2,
  resumeQueueLaneV2,
  resumeQueueJobV2,
  retryQueueJobV2,
  type DistillationQueueName,
  type DistillationQueueStatus,
  type QueueListItemV2,
} from "../repositories/admin.repository";

const QUEUE_TABS: Array<{ name: DistillationQueueName; label: string }> = [
  { name: "findingCandidate", label: "Finding" },
  { name: "coveringEvidence", label: "Covering" },
  { name: "premiumCoveringEvidence", label: "Premium" },
  { name: "finalizeDistille", label: "Finalize" },
];

const STATUS_FILTERS: Array<DistillationQueueStatus | "all"> = [
  "all",
  "pending",
  "running",
  "paused",
  "failed",
  "completed",
  "skipped",
];

const queueLabel: Record<DistillationQueueName, string> = {
  findingCandidate: "Finding",
  coveringEvidence: "Covering",
  premiumCoveringEvidence: "Premium",
  finalizeDistille: "Finalize",
};

const queueCardVisuals: Record<
  DistillationQueueName,
  {
    Icon: LucideIcon;
    iconColor: string;
    selectedBorder: string;
    selectedRing: string;
  }
> = {
  findingCandidate: {
    Icon: Search,
    iconColor: "text-blue-600",
    selectedBorder: "border-blue-300",
    selectedRing: "ring-blue-100",
  },
  coveringEvidence: {
    Icon: Mail,
    iconColor: "text-emerald-600",
    selectedBorder: "border-emerald-300",
    selectedRing: "ring-emerald-100",
  },
  premiumCoveringEvidence: {
    Icon: Gem,
    iconColor: "text-orange-500",
    selectedBorder: "border-orange-300",
    selectedRing: "ring-orange-100",
  },
  finalizeDistille: {
    Icon: CircleCheck,
    iconColor: "text-cyan-600",
    selectedBorder: "border-cyan-300",
    selectedRing: "ring-cyan-100",
  },
};

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "-";
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return "-";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString();
}

function formatElapsed(startedAt: string | null, nowMs: number): string {
  if (!startedAt) return "-";
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return "-";
  const elapsedSec = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const hours = Math.floor(elapsedSec / 3600);
  const minutes = Math.floor((elapsedSec % 3600) / 60);
  const seconds = elapsedSec % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function formatCount(value: number | undefined): string {
  return Number(value ?? 0).toLocaleString("en-US");
}

type QueueLlmStatus = "Active" | "Ready" | "Offline" | "Paused";

function resolveQueueLlmStatus(params: {
  running: number;
  offline: number;
  paused: boolean;
}): QueueLlmStatus {
  if (params.paused) return "Paused";
  if (params.offline > 0 && params.running === 0) return "Offline";
  if (params.running > 0) return "Active";
  return "Ready";
}

function resolveTaskStartAt(item: QueueListItemV2): string | null {
  return item.lockedAt ?? item.heartbeatAt ?? null;
}

function resolveModelLabel(item: QueueListItemV2): string {
  const model = item.model?.trim();
  if (model) return model;
  const provider = item.provider?.trim();
  if (provider) return provider;
  return "unknown-model";
}

function statusTone(status: DistillationQueueStatus): string {
  switch (status) {
    case "running":
      return "border-amber-300 bg-amber-50 text-amber-800";
    case "pending":
      return "border-sky-300 bg-sky-50 text-sky-800";
    case "paused":
      return "border-violet-300 bg-violet-50 text-violet-800";
    case "failed":
      return "border-rose-300 bg-rose-50 text-rose-800";
    case "completed":
      return "border-emerald-300 bg-emerald-50 text-emerald-800";
    default:
      return "border-slate-300 bg-slate-50 text-slate-700";
  }
}

type ActionMode = "pause" | "resume" | "retry";

function actionState(item: QueueListItemV2): {
  pauseDisabled: boolean;
  pauseReason: string;
  resumeDisabled: boolean;
  resumeReason: string;
  retryDisabled: boolean;
  retryReason: string;
} {
  const pauseDisabled = !(item.status === "pending" || item.status === "running");
  const resumeDisabled = !(
    item.status === "paused" ||
    item.status === "failed" ||
    item.status === "skipped"
  );
  const retryDisabled = item.status === "running";
  return {
    pauseDisabled,
    pauseReason: pauseDisabled ? "Only pending/running can pause" : "Pause queue job",
    resumeDisabled,
    resumeReason: resumeDisabled ? "Only paused/failed/skipped can resume" : "Resume queue job",
    retryDisabled,
    retryReason: retryDisabled ? "Running job cannot retry" : "Retry from the beginning",
  };
}

export function QueuePage() {
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<DistillationQueueName>("findingCandidate");
  const [status, setStatus] = useState<DistillationQueueStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [actioning, setActioning] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: "priority", desc: true }]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const statsQuery = useQuery({
    queryKey: ["queue-v2-stats"],
    queryFn: fetchQueueDashboardStatsV2,
    refetchInterval: 5000,
  });
  const activeQuery = useQuery({
    queryKey: ["queue-v2-active"],
    queryFn: fetchActiveQueueTasksV2,
    refetchInterval: 2500,
  });
  const itemsQuery = useQuery({
    queryKey: ["queue-v2-items", queue, status, query, page, sorting],
    queryFn: () =>
      fetchQueueItemsV2({
        queue,
        status,
        query,
        page,
        limit: 20,
        sortBy: sorting[0]?.id,
        sortDir: sorting[0]?.desc ? "desc" : "asc",
      }),
    placeholderData: (prev) => prev,
  });

  const invalidateQueue = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["queue-v2-stats"] }),
      queryClient.invalidateQueries({ queryKey: ["queue-v2-active"] }),
      queryClient.invalidateQueries({ queryKey: ["queue-v2-items"] }),
    ]);
  };

  const pauseMutation = useMutation({
    mutationFn: (input: { queue: DistillationQueueName; id: string }) =>
      pauseQueueJobV2(input.queue, input.id),
    onSuccess: () => void invalidateQueue(),
    onSettled: () => setActioning(null),
  });
  const resumeMutation = useMutation({
    mutationFn: (input: { queue: DistillationQueueName; id: string }) =>
      resumeQueueJobV2(input.queue, input.id),
    onSuccess: () => void invalidateQueue(),
    onSettled: () => setActioning(null),
  });
  const retryMutation = useMutation({
    mutationFn: (input: { queue: DistillationQueueName; id: string }) =>
      retryQueueJobV2({
        queue: input.queue,
        id: input.id,
        mode: input.queue === "premiumCoveringEvidence" ? "cloud_api" : "default",
        forceRefreshEvidence: true,
      }),
    onSuccess: () => void invalidateQueue(),
    onSettled: () => setActioning(null),
  });
  const lanePauseMutation = useMutation({
    mutationFn: (input: { queue: DistillationQueueName }) => pauseQueueLaneV2(input.queue),
    onSuccess: () => void invalidateQueue(),
    onSettled: () => setActioning(null),
  });
  const laneResumeMutation = useMutation({
    mutationFn: (input: { queue: DistillationQueueName }) => resumeQueueLaneV2(input.queue),
    onSuccess: () => void invalidateQueue(),
    onSettled: () => setActioning(null),
  });

  const checkedAt = Math.max(
    statsQuery.dataUpdatedAt ?? 0,
    activeQuery.dataUpdatedAt ?? 0,
    itemsQuery.dataUpdatedAt ?? 0,
  );
  const hasError = statsQuery.isError || activeQuery.isError || itemsQuery.isError;
  const activeCount = activeQuery.data?.length ?? 0;

  const onAction = useCallback(
    (item: QueueListItemV2, mode: ActionMode) => {
      const actionKey = `${mode}:${item.queueName}:${item.id}`;
      setActioning(actionKey);
      if (mode === "pause") {
        pauseMutation.mutate({ queue: item.queueName, id: item.id });
        return;
      }
      if (mode === "resume") {
        resumeMutation.mutate({ queue: item.queueName, id: item.id });
        return;
      }
      retryMutation.mutate({ queue: item.queueName, id: item.id });
    },
    [pauseMutation, resumeMutation, retryMutation],
  );

  const onLaneControl = useCallback(
    (queueName: DistillationQueueName, paused: boolean) => {
      const actionKey = `${paused ? "lane-resume" : "lane-pause"}:${queueName}`;
      setActioning(actionKey);
      if (paused) {
        laneResumeMutation.mutate({ queue: queueName });
        return;
      }
      lanePauseMutation.mutate({ queue: queueName });
    },
    [lanePauseMutation, laneResumeMutation],
  );

  const queueStats = statsQuery.data?.queues;
  const totals = statsQuery.data?.totals;
  const finalizeCompletedCount = queueStats?.finalizeDistille?.counters.completed ?? 0;
  const totalQueueCount = totals
    ? Object.values(totals.counters).reduce((sum, count) => sum + Number(count ?? 0), 0)
    : 0;
  const items = itemsQuery.data?.items ?? [];
  const activeItems = activeQuery.data ?? [];

  const activeByQueue = useMemo(() => {
    const map = new Map<DistillationQueueName, number>();
    for (const tab of QUEUE_TABS) map.set(tab.name, 0);
    for (const item of activeItems) map.set(item.queueName, (map.get(item.queueName) ?? 0) + 1);
    return map;
  }, [activeItems]);

  const telemetryByQueue = useMemo(() => {
    const map = new Map<DistillationQueueName, QueueListItemV2[]>();
    for (const tab of QUEUE_TABS) {
      map.set(tab.name, []);
    }
    for (const item of activeItems) {
      map.set(item.queueName, [...(map.get(item.queueName) ?? []), item]);
    }
    return map;
  }, [activeItems]);

  const telemetryCards = useMemo(() => {
    const cards: Array<ReactNode> = [];
    for (const tab of QUEUE_TABS) {
      const runningCount = queueStats?.[tab.name]?.counters.running ?? 0;
      const rows = telemetryByQueue.get(tab.name) ?? [];
      for (const item of rows) {
        cards.push(
          <div
            key={`active-${item.queueName}-${item.id}`}
            className="rounded-md border bg-white px-3 py-2.5"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p
                  className="truncate text-[12px] font-semibold text-slate-800"
                  title={item.subjectTitle}
                >
                  {item.subjectTitle}
                </p>
                <p className="truncate text-[10px] text-slate-500" title={item.subjectDetail}>
                  {item.subjectDetail}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Badge variant="outline" className={statusTone(item.status)}>
                  {item.status}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {queueLabel[item.queueName]}
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px] text-slate-600">
              <span className="truncate text-slate-500">{item.lockedBy ?? "-"}</span>
              <span className="inline-flex items-center justify-end gap-1 font-mono">
                <Timer size={12} className="text-amber-600" />
                {formatElapsed(resolveTaskStartAt(item), nowMs)}
              </span>
              <span className="inline-flex items-center gap-1 truncate">
                <Cpu size={12} className="text-cyan-600" />
                {resolveModelLabel(item)}
              </span>
              <span className="truncate text-right text-slate-500">p{item.priority}</span>
            </div>
          </div>,
        );
      }
      if (runningCount > 0 && rows.length === 0) {
        cards.push(
          <div
            key={`active-fallback-${tab.name}`}
            className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-amber-800">
                {queueLabel[tab.name]} running: {runningCount}
              </span>
              <Badge variant="outline" className="text-[10px]">
                telemetry pending
              </Badge>
            </div>
          </div>,
        );
      }
    }
    return cards;
  }, [nowMs, queueStats, telemetryByQueue]);

  const columns = useMemo<ColumnDef<QueueListItemV2>[]>(
    () => [
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge variant="outline" className={statusTone(row.original.status)}>
            {row.original.status}
          </Badge>
        ),
      },
      {
        accessorKey: "priority",
        header: "優先度",
        cell: ({ row }) => <span className="text-sm tabular-nums">{row.original.priority}</span>,
      },
      {
        accessorKey: "subjectTitle",
        header: "Subject",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="whitespace-normal">
              <div className="font-medium text-slate-800">{item.subjectTitle}</div>
              <div className="text-xs text-muted-foreground">{item.subjectDetail}</div>
              {item.lastError ? (
                <div className="mt-1 text-xs text-rose-600">{item.lastError}</div>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: "attemptCount",
        header: "Attempt",
        cell: ({ row }) => <span className="tabular-nums">{row.original.attemptCount}</span>,
      },
      {
        accessorKey: "updatedAt",
        header: "更新",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(row.original.updatedAt)}
          </span>
        ),
      },
      {
        accessorKey: "lockedBy",
        header: "Worker",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="text-xs">
              <div className="truncate text-slate-700">{item.lockedBy ?? "-"}</div>
              <div className="truncate text-muted-foreground">
                {item.model ?? item.provider ?? "-"}
              </div>
            </div>
          );
        },
      },
      {
        id: "action",
        header: "Action",
        enableSorting: false,
        cell: ({ row }) => {
          const item = row.original;
          const state = actionState(item);
          const pauseKey = `pause:${item.queueName}:${item.id}`;
          const resumeKey = `resume:${item.queueName}:${item.id}`;
          const retryKey = `retry:${item.queueName}:${item.id}`;
          return (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                title={state.pauseReason}
                disabled={state.pauseDisabled || actioning === pauseKey}
                onClick={() => onAction(item, "pause")}
              >
                {actioning === pauseKey ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Pause size={14} />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title={state.resumeReason}
                disabled={state.resumeDisabled || actioning === resumeKey}
                onClick={() => onAction(item, "resume")}
              >
                {actioning === resumeKey ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title={state.retryReason}
                disabled={state.retryDisabled || actioning === retryKey}
                onClick={() => onAction(item, "retry")}
              >
                {actioning === retryKey ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <RotateCcw size={14} />
                )}
              </Button>
            </div>
          );
        },
      },
    ],
    [actioning, onAction],
  );

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    enableMultiSort: false,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Distillation Queues"
        checkedAtText={
          checkedAt ? formatRelativeTime(new Date(checkedAt).toISOString()) : undefined
        }
        onRefresh={() => void invalidateQueue()}
        refreshDisabled={statsQuery.isFetching || activeQuery.isFetching || itemsQuery.isFetching}
        status={hasError ? "failed" : activeCount > 0 ? "ok" : "degraded"}
        statusLabel={
          hasError ? "Queue API Error" : activeCount > 0 ? `${activeCount} Running` : "Idle"
        }
      />

      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="grid h-full min-h-0 grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            <section className="overview-domain-section accent-cyan">
              <div className="overview-domain-header justify-between items-center border-b border-cyan-500/10 pb-3">
                <div className="flex items-center gap-2">
                  <Activity className="overview-domain-icon text-cyan-500" />
                  <div>
                    <h2 className="overview-domain-title text-[15px] font-bold text-slate-800">
                      LLM Task Telemetry
                    </h2>
                    <p className="text-[11px] text-slate-400">Running タスク / worker heartbeat</p>
                  </div>
                </div>
                <Badge variant="outline" className="border-cyan-200 bg-cyan-50 text-cyan-700">
                  {totals?.counters.running ?? 0} Running
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-2 border-b border-slate-100 pb-3 text-left sm:grid-cols-4">
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Running
                  </span>
                  <strong className="text-lg font-extrabold text-amber-600">
                    {totals?.counters.running ?? 0}
                  </strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Failed
                  </span>
                  <strong className="text-lg font-extrabold text-rose-600">
                    {totals?.counters.failed ?? 0}
                  </strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Completed
                  </span>
                  <strong className="text-lg font-extrabold text-emerald-600">
                    {formatCount(finalizeCompletedCount)}
                  </strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Total
                  </span>
                  <strong className="text-lg font-extrabold text-slate-700">
                    {formatCount(totalQueueCount)}
                  </strong>
                </div>
              </div>

              <div className="space-y-2">
                {telemetryCards.length === 0 ? (
                  <div className="rounded-md border border-emerald-100 bg-emerald-50/60 px-3 py-4 text-center text-sm text-emerald-700">
                    Running タスクはありません。
                  </div>
                ) : (
                  telemetryCards
                )}
              </div>
            </section>
          </div>

          <div className="min-h-0 space-y-4 overflow-y-auto">
            <section className="space-y-2">
              <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-4">
                {QUEUE_TABS.map((tab) => {
                  const snapshot = queueStats?.[tab.name];
                  const pending = snapshot?.counters.pending ?? 0;
                  const running = snapshot?.counters.running ?? activeByQueue.get(tab.name) ?? 0;
                  const completed = snapshot?.counters.completed ?? 0;
                  const failed = snapshot?.counters.failed ?? 0;
                  const paused = snapshot?.counters.paused ?? 0;
                  const offline = snapshot?.offline ?? 0;
                  const nonRegistered = snapshot?.nonRegistered ?? 0;
                  const laneControl = statsQuery.data?.queueControls?.[tab.name];
                  const lanePaused = laneControl?.paused === true;
                  const llmStatus = resolveQueueLlmStatus({ running, offline, paused: lanePaused });
                  const laneActionKey = `${lanePaused ? "lane-resume" : "lane-pause"}:${tab.name}`;
                  const showsNonRegistered =
                    tab.name === "coveringEvidence" || tab.name === "premiumCoveringEvidence";
                  const visuals = queueCardVisuals[tab.name];
                  const selected = queue === tab.name;
                  return (
                    <button
                      key={tab.name}
                      type="button"
                      aria-label={tab.label}
                      aria-pressed={selected}
                      onClick={() => {
                        setQueue(tab.name);
                        setPage(1);
                      }}
                      className={`rounded-xl border bg-white px-4 py-3.5 text-left transition ${
                        selected
                          ? `${visuals.selectedBorder} ring-2 ${visuals.selectedRing} shadow-sm`
                          : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <div className="mb-3 flex items-center gap-2">
                        <visuals.Icon className={`h-5 w-5 ${visuals.iconColor}`} />
                        <span className="text-sm font-semibold text-slate-900">{tab.label}</span>
                      </div>

                      <div className="mb-3 flex items-center gap-2">
                        <p className="text-xl font-semibold leading-none tracking-tight text-slate-900">
                          {formatCount(pending)}
                          <span className="ml-1 text-xs font-medium text-slate-500">件</span>
                        </p>
                        <Badge
                          variant="outline"
                          className={
                            llmStatus === "Paused"
                              ? "border-violet-300 bg-violet-50 text-violet-700"
                              : llmStatus === "Active"
                                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                                : llmStatus === "Offline"
                                  ? "border-rose-300 bg-rose-50 text-rose-700"
                                  : "border-sky-300 bg-sky-50 text-sky-700"
                          }
                        >
                          {llmStatus}
                        </Badge>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-[11px]"
                          disabled={actioning === laneActionKey}
                          onClick={(event) => {
                            event.stopPropagation();
                            onLaneControl(tab.name, lanePaused);
                          }}
                        >
                          {actioning === laneActionKey ? (
                            <RefreshCw size={12} className="mr-1 animate-spin" />
                          ) : lanePaused ? (
                            <Play size={12} className="mr-1" />
                          ) : (
                            <Pause size={12} className="mr-1" />
                          )}
                          {lanePaused ? "再開" : "一時停止"}
                        </Button>
                      </div>

                      <div className="grid grid-cols-[1fr_auto] gap-x-4 text-xs text-slate-600">
                        <div className="space-y-1 border-r border-slate-200 pr-4">
                          <div>完了</div>
                          <div>失敗</div>
                          <div>一時停止</div>
                          {showsNonRegistered ? <div>非登録</div> : null}
                        </div>
                        <div className="space-y-1 text-right font-medium text-slate-800">
                          <div>{formatCount(completed)}</div>
                          <div>{formatCount(failed)}</div>
                          <div>{formatCount(paused)}</div>
                          {showsNonRegistered ? <div>{formatCount(nonRegistered)}</div> : null}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="overview-domain-section accent-violet">
              <div className="overview-domain-header justify-between items-center border-b border-violet-500/10 pb-2">
                <h3 className="overview-domain-title text-[15px] font-bold text-slate-800">
                  Queue Registry
                </h3>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value as DistillationQueueStatus | "all");
                      setPage(1);
                    }}
                    className="h-8 rounded-md border px-2 text-sm"
                  >
                    {STATUS_FILTERS.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-slate-400" />
                    <Input
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setPage(1);
                      }}
                      placeholder="検索"
                      className="h-8 w-48 pl-8"
                    />
                  </div>
                </div>
              </div>

              <div className="knowledge-table-container">
                <div className="shrink-0 border-b bg-background shadow-sm">
                  <table className="w-full table-fixed caption-bottom text-sm">
                    <colgroup>
                      <col className="w-[13%]" />
                      <col className="w-[8%]" />
                      <col className="w-[33%]" />
                      <col className="w-[8%]" />
                      <col className="w-[13%]" />
                      <col className="w-[13%]" />
                      <col className="w-[12%]" />
                    </colgroup>
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
                    <colgroup>
                      <col className="w-[13%]" />
                      <col className="w-[8%]" />
                      <col className="w-[33%]" />
                      <col className="w-[8%]" />
                      <col className="w-[13%]" />
                      <col className="w-[13%]" />
                      <col className="w-[12%]" />
                    </colgroup>
                    <TableBody>
                      {table.getRowModel().rows.map((row) => (
                        <TableRow
                          key={row.id}
                          className="group transition-colors hover:bg-muted/50"
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                      {table.getRowModel().rows.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={7}
                            className="py-16 text-center text-sm text-muted-foreground"
                          >
                            No queue jobs
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </table>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Prev
                </Button>
                <span className="text-sm">Page {page}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(itemsQuery.data?.items.length ?? 0) < 20}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
