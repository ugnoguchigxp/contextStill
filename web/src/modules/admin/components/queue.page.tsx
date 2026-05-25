import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminPageHeader } from "./admin-page-header";
import { QueueRegistryPanel } from "./queue-registry-panel";
import { QueueTelemetryPanel } from "./queue-telemetry-panel";
import {
  fetchActiveQueueTasks,
  fetchQueueDashboardStats,
  fetchQueueItems,
  pauseQueueTarget,
  resumeQueueTarget,
  type DistillationTargetState,
  type QueueDashboardStats,
  type QueueListResponse,
  type QueueTargetKindFilter,
  type QueueTargetStatusFilter,
} from "../repositories/admin.repository";
import {
  formatCooldownCountdown,
  formatFindCandidateReason,
  formatFindCandidateTarget,
  formatRelativeTime,
} from "./queue.page.helpers";

export function QueuePage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<QueueTargetKindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<QueueTargetStatusFilter>("all");
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const statsQuery = useQuery<QueueDashboardStats>({
    queryKey: ["queue-stats"],
    queryFn: fetchQueueDashboardStats,
    refetchInterval: 5000,
  });

  const activeQuery = useQuery<DistillationTargetState[]>({
    queryKey: ["queue-active"],
    queryFn: fetchActiveQueueTasks,
    refetchInterval: 2500,
  });

  const itemsQuery = useQuery<QueueListResponse>({
    queryKey: ["queue-items", page, search, kindFilter, statusFilter],
    queryFn: () =>
      fetchQueueItems({
        page,
        limit: 15,
        query: search,
        targetKind: kindFilter,
        status: statusFilter,
      }),
    placeholderData: (previousData) => previousData,
  });

  const pauseMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => pauseQueueTarget(id, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["queue-stats"] });
      void queryClient.invalidateQueries({ queryKey: ["queue-active"] });
      void queryClient.invalidateQueries({ queryKey: ["queue-items"] });
    },
    onSettled: () => setActioningId(null),
  });

  const resumeMutation = useMutation({
    mutationFn: (id: string) => resumeQueueTarget(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["queue-stats"] });
      void queryClient.invalidateQueries({ queryKey: ["queue-active"] });
      void queryClient.invalidateQueries({ queryKey: ["queue-items"] });
    },
    onSettled: () => setActioningId(null),
  });

  const stats = statsQuery.data?.stats ?? {};
  const findCandidateStatus = statsQuery.data?.findCandidate;
  const findCandidateState = findCandidateStatus?.status ?? "idle";
  const findCandidateWaiting = findCandidateState === "waiting";
  const findCandidateRunning = findCandidateState === "running";
  const findCandidateWaitUntil = findCandidateStatus?.waitUntil ?? null;
  const findCandidateLabel =
    findCandidateState === "idle"
      ? "idle"
      : findCandidateRunning
        ? "active"
        : formatCooldownCountdown(findCandidateWaitUntil, nowMs);
  const findCandidateDetail = findCandidateStatus
    ? `${formatFindCandidateReason(findCandidateStatus.reason)} / ${formatFindCandidateTarget(
        findCandidateStatus.targetKind,
      )}`
    : "loading";

  useEffect(() => {
    if (!findCandidateWaitUntil) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [findCandidateWaitUntil]);

  const activeTasks = activeQuery.data ?? [];
  const listData = itemsQuery.data;
  const runningCount = Number(stats.running ?? 0);
  const hasQueryError = statsQuery.isError || activeQuery.isError || itemsQuery.isError;
  const hasRunningWithoutLock = runningCount > 0 && activeTasks.length === 0;
  const lastUpdatedAtMs = Math.max(
    statsQuery.dataUpdatedAt ?? 0,
    activeQuery.dataUpdatedAt ?? 0,
    itemsQuery.dataUpdatedAt ?? 0,
  );
  const checkedAtText = lastUpdatedAtMs
    ? formatRelativeTime(new Date(lastUpdatedAtMs).toISOString())
    : undefined;
  const totalItems = Object.values(stats).reduce((a, b) => a + b, 0);

  const handlePause = (id: string) => {
    setActioningId(id);
    pauseMutation.mutate({ id, reason: "Manually paused from visual Control Plane" });
  };

  const handleResume = (id: string) => {
    setActioningId(id);
    resumeMutation.mutate(id);
  };

  const handleRefreshAll = () => {
    void Promise.all([statsQuery.refetch(), activeQuery.refetch(), itemsQuery.refetch()]);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Distillation Queue Control Plane"
        checkedAtText={checkedAtText}
        onRefresh={handleRefreshAll}
        refreshDisabled={statsQuery.isFetching || activeQuery.isFetching || itemsQuery.isFetching}
        status={hasQueryError ? "failed" : hasRunningWithoutLock ? "degraded" : "ok"}
        statusLabel={
          hasQueryError
            ? "Queue API Error"
            : hasRunningWithoutLock
              ? "Worker heartbeat stale"
              : activeTasks.length > 0
                ? `${activeTasks.length} Processing`
                : "Queue Idle"
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
          <div className="xl:col-span-1">
            <QueueTelemetryPanel
              activeTasks={activeTasks}
              actioningId={actioningId}
              totalItems={totalItems}
              stats={stats}
              onPause={handlePause}
            />
          </div>
          <div className="xl:col-span-2">
            <QueueRegistryPanel
              stats={stats}
              findCandidateState={findCandidateState}
              findCandidateWaiting={findCandidateWaiting}
              findCandidateRunning={findCandidateRunning}
              findCandidateLabel={findCandidateLabel}
              findCandidateDetail={findCandidateDetail}
              findCandidateModel={findCandidateStatus?.model}
              search={search}
              setSearch={setSearch}
              kindFilter={kindFilter}
              setKindFilter={setKindFilter}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              page={page}
              setPage={setPage}
              listData={listData}
              itemsLoading={itemsQuery.isLoading}
              actioningId={actioningId}
              onPause={handlePause}
              onResume={handleResume}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
