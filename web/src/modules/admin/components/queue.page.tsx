import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Play,
  Pause,
  RotateCcw,
  Search,
  Clock,
  Database,
  Layers,
  Activity,
  AlertCircle,
  RefreshCw,
  Cpu,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { AdminPageHeader } from "./admin-page-header";
import {
  fetchQueueDashboardStats,
  fetchActiveQueueTasks,
  fetchQueueItems,
  pauseQueueTarget,
  resumeQueueTarget,
  type DistillationTargetState,
  type QueueDashboardStats,
  type QueueListResponse,
  type QueueTargetKindFilter,
  type QueueTargetStatusFilter,
} from "../repositories/admin.repository";

// Helper to format Date
function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffSec < 60) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCooldownCountdown(cooldownUntil: string | null, nowMs: number): string {
  if (!cooldownUntil) return "ready";
  const untilMs = Date.parse(cooldownUntil);
  if (!Number.isFinite(untilMs)) return "unknown";
  const remainingMs = Math.max(0, untilMs - nowMs);
  if (remainingMs <= 0) return "ready";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return `${hours}h ${restMinutes}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatFindCandidateReason(reason: QueueDashboardStats["findCandidate"]["reason"]): string {
  switch (reason) {
    case "provider_cooldown":
      return "provider cooldown";
    case "recent_interactive_compile":
      return "recent compile";
    case "interactive_pressure":
      return "interactive pressure";
    case "parallel_lane_busy":
      return "parallel lane busy";
    case "next_retry":
      return "retry scheduled";
    case "no_target":
      return "no target";
    default:
      return reason.replaceAll("_", " ");
  }
}

function formatFindCandidateTarget(
  targetKind: QueueDashboardStats["findCandidate"]["targetKind"],
): string {
  if (!targetKind) return "queue idle";
  return targetKind.replace("_", " ");
}

// Maps Phase to visual progress checklist steps
const STEPS_IN_PIPELINE = [
  { key: "selected", label: "Target Selected" },
  { key: "reading", label: "Reading Content" },
  { key: "researching_source", label: "Researching Source" },
  { key: "writing_source", label: "Writing Source Markdown" },
  { key: "finding_candidate", label: "Finding Candidates" },
  { key: "covering_evidence", label: "Covering Evidence" },
  { key: "finalizing", label: "Finalizing States" },
  { key: "stored", label: "Stored in Registry" },
];

const PHASE_MAP: Record<string, { label: string }> = {
  selected: { label: "Target Selected" },
  reading: { label: "Reading Content" },
  researching_source: { label: "Researching Source" },
  writing_source: { label: "Writing Source Markdown" },
  finding_candidate: { label: "Finding Candidates" },
  covering_evidence: { label: "Covering Evidence" },
  finalizing: { label: "Finalizing States" },
  stored: { label: "Stored in Registry" },
};

export function QueuePage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<QueueTargetKindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<QueueTargetStatusFilter>("all");
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Queries
  const statsQuery = useQuery<QueueDashboardStats>({
    queryKey: ["queue-stats"],
    queryFn: fetchQueueDashboardStats,
    refetchInterval: 5000, // Poll stats every 5s
  });

  const activeQuery = useQuery<DistillationTargetState[]>({
    queryKey: ["queue-active"],
    queryFn: fetchActiveQueueTasks,
    refetchInterval: 2500, // Poll active jobs every 2.5s for real-time monitoring
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

  // Mutations
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

  // Aggregate total items in queue
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
        {/* Main 2-Column Responsive Layout matching Overview page grid style */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
          {/* ==================== LEFT COLUMN: TELEMETRY & ACTIVE STEPS ==================== */}
          <div className="xl:col-span-1">
            <section className="overview-domain-section accent-cyan shadow-sm">
              {/* Header */}
              <div className="overview-domain-header justify-between items-center border-b border-cyan-500/10 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 bg-cyan-50 rounded-lg">
                    <Activity
                      className="overview-domain-icon text-cyan-500 w-4 h-4"
                      style={{ color: "#06b6d4" }}
                    />
                  </div>
                  <div className="flex flex-col">
                    <h2 className="overview-domain-title text-[15px] font-bold text-slate-800 leading-none">
                      Distillation Telemetry
                    </h2>
                    <span className="text-[11.5px] text-slate-400 font-medium mt-1">
                      Active worker loops & execution logs
                    </span>
                  </div>
                </div>
                {activeTasks.length > 0 && (
                  <div className="flex items-center gap-1 bg-cyan-50 px-2 py-0.5 rounded-full border border-cyan-100">
                    <span className="status-pulse-dot" style={{ backgroundColor: "#06b6d4" }} />
                    <span className="text-[10px] text-cyan-600 font-bold uppercase tracking-wider">
                      Live
                    </span>
                  </div>
                )}
              </div>

              {/* Integrated queue stats and provider cooldown inside Header */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 border-b border-slate-100/60 pb-3.5 pt-1 text-left">
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-400 font-bold tracking-wide uppercase">
                    Total Queue
                  </span>
                  <strong className="text-slate-800 text-[20px] font-extrabold mt-0.5 leading-none">
                    {totalItems}
                  </strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-400 font-bold tracking-wide uppercase">
                    Running
                  </span>
                  <strong className="text-amber-600 text-[20px] font-extrabold mt-0.5 leading-none animate-pulse">
                    {stats.running ?? 0}
                  </strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-400 font-bold tracking-wide uppercase">
                    Pending
                  </span>
                  <strong className="text-slate-800 text-[20px] font-extrabold mt-0.5 leading-none">
                    {stats.pending ?? 0}
                  </strong>
                </div>
              </div>

              {/* Live Telemetry checklist or idle block */}
              <div className="flex flex-col gap-4 pt-1">
                {activeTasks.length > 0 ? (
                  activeTasks.map((task) => {
                    // Find active step index
                    const activeStepIndex = STEPS_IN_PIPELINE.findIndex(
                      (s) => s.key === task.phase,
                    );

                    return (
                      <div key={task.id} className="space-y-4">
                        {/* Compact Task ID block */}
                        <div className="flex flex-col gap-1 bg-slate-50 border border-slate-100/80 rounded-lg p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-[11.5px] font-bold text-slate-800 font-mono break-all select-all pr-2">
                              {task.targetKey.length > 36
                                ? `${task.targetKey.substring(0, 36)}...`
                                : task.targetKey}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[9px] font-extrabold uppercase bg-cyan-50 text-cyan-700 border-cyan-300/30"
                            >
                              {task.targetKind.replace("_", " ")}
                            </Badge>
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold mt-1">
                            <div className="flex items-center gap-1">
                              <Cpu size={11} className="text-slate-300" />
                              <span>Try: {task.attemptCount}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <User size={11} className="text-slate-300" />
                              <span className="truncate max-w-[100px]">{task.lockedBy}</span>
                            </div>
                          </div>
                        </div>

                        {/* Visual checklist stepper */}
                        <div className="space-y-3 pl-1">
                          <span className="text-[12.5px] font-bold text-slate-700 tracking-wide uppercase">
                            Pipeline Progress
                          </span>
                          <div className="relative border-l-2 border-slate-100 ml-2 pl-4 space-y-4 pt-1">
                            {STEPS_IN_PIPELINE.map((step, idx) => {
                              const isCompleted = idx < activeStepIndex;
                              const isActive = idx === activeStepIndex;
                              const isUnreached = idx > activeStepIndex;

                              let stepDotColor = "bg-slate-200 border-slate-300";
                              let stepTextColor = "text-slate-400 font-medium";
                              let stepBgClass = "bg-slate-100";

                              if (isCompleted) {
                                stepDotColor =
                                  "bg-cyan-500 border-cyan-400 shadow-sm shadow-cyan-500/20";
                                stepTextColor = "text-slate-700 font-semibold";
                                stepBgClass = "bg-cyan-500";
                              } else if (isActive) {
                                stepDotColor =
                                  "bg-amber-500 border-amber-400 shadow-sm shadow-amber-500/20 animate-pulse";
                                stepTextColor = "text-amber-700 font-bold";
                                stepBgClass = "bg-amber-500";
                              }

                              return (
                                <div key={step.key} className="relative flex flex-col gap-1.5">
                                  {/* Connected bullet dot */}
                                  <span
                                    className={`absolute -left-[23px] top-1.5 w-2 h-2 rounded-full border ${stepDotColor}`}
                                  />

                                  <div className="flex items-baseline justify-between">
                                    <span className={`text-[12.5px] ${stepTextColor}`}>
                                      {step.label}
                                    </span>
                                    {isActive && (
                                      <span className="text-[11.5px] font-bold text-amber-600 animate-pulse">
                                        active
                                      </span>
                                    )}
                                  </div>

                                  {/* Progress micro-bar */}
                                  <div className="w-full h-1 bg-slate-100/80 rounded-full overflow-hidden flex">
                                    <div
                                      className={`h-full ${stepBgClass} transition-all duration-300`}
                                      style={{
                                        width: isCompleted ? "100%" : isActive ? "65%" : "0%",
                                      }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Task metadata footer & action */}
                        <div className="flex items-center justify-between pt-3 border-t border-slate-100/60 text-[11.5px] text-slate-400 font-semibold">
                          <div className="flex items-center gap-1">
                            <Clock size={12} className="text-slate-300" />
                            <span>Heartbeat: {formatRelativeTime(task.heartbeatAt)}</span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handlePause(task.id)}
                            disabled={actioningId === task.id}
                            className="h-7 text-[11.5px] font-bold border border-amber-200 text-amber-600 bg-amber-50/50 hover:bg-amber-100/60 rounded px-2.5 gap-1.5"
                          >
                            <Pause size={12} />
                            Pause State
                          </Button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <div className="relative mb-3 flex items-center justify-center p-3 bg-emerald-50 rounded-full border border-emerald-100/50">
                      <Database className="w-8 h-8 text-emerald-500" />
                      <div className="absolute top-0 right-0 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white animate-pulse" />
                    </div>
                    <h3 className="text-[13.5px] font-bold text-slate-700">Pipeline Daemon Idle</h3>
                    <p className="text-[11.5px] text-slate-400 max-w-[220px] mt-1 leading-relaxed">
                      No active distillation locks. Watching database for new code vibes or
                      changes...
                    </p>
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* ==================== RIGHT COLUMN: QUEUE REGISTRY INDEX TABLE ==================== */}
          <div className="xl:col-span-2">
            <section className="overview-domain-section accent-violet shadow-sm bg-white">
              {/* Header */}
              <div className="overview-domain-header justify-between items-center border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 bg-violet-50 rounded-lg">
                    <Layers
                      className="overview-domain-icon text-violet-500 w-4 h-4"
                      style={{ color: "#8b5cf6" }}
                    />
                  </div>
                  <div className="flex flex-col">
                    <h2 className="overview-domain-title text-[15px] font-bold text-slate-800 leading-none">
                      Task Queue Registry
                    </h2>
                    <span className="text-[11.5px] text-slate-400 font-medium mt-1">
                      Inspect, query, and retry compiled targets
                    </span>
                  </div>
                </div>
              </div>

              {/* Integrated queue stats inside Header */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 border-b border-slate-100/60 pb-3.5 pt-1 text-left">
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-400 font-bold tracking-wide uppercase">
                    Completed
                  </span>
                  <strong className="text-emerald-600 text-[20px] font-extrabold mt-0.5 leading-none">
                    {stats.completed ?? 0}
                  </strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-400 font-bold tracking-wide uppercase">
                    Failed
                  </span>
                  <strong
                    className={
                      stats.failed && stats.failed > 0
                        ? "text-red-600 text-[20px] font-extrabold mt-0.5 leading-none"
                        : "text-slate-800 text-[20px] font-extrabold mt-0.5 leading-none"
                    }
                  >
                    {stats.failed ?? 0}
                  </strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-400 font-bold tracking-wide uppercase">
                    Paused / Skipped
                  </span>
                  <strong className="text-slate-800 text-[20px] font-extrabold mt-0.5 leading-none">
                    {(stats.paused ?? 0) + (stats.skipped ?? 0)}
                  </strong>
                </div>
                <div
                  className="flex flex-col"
                  data-state={findCandidateState}
                  aria-label="findCandidate wait"
                >
                  <span className="text-[10px] text-slate-400 font-bold tracking-wide uppercase">
                    FindCandidate
                  </span>
                  <strong
                    className={
                      findCandidateWaiting
                        ? "text-amber-600 text-[20px] font-extrabold mt-0.5 leading-none"
                        : findCandidateRunning
                          ? "text-cyan-600 text-[20px] font-extrabold mt-0.5 leading-none animate-pulse"
                          : findCandidateState === "idle"
                            ? "text-slate-800 text-[20px] font-extrabold mt-0.5 leading-none"
                            : "text-emerald-600 text-[20px] font-extrabold mt-0.5 leading-none"
                    }
                  >
                    {findCandidateLabel}
                  </strong>
                  <span
                    className="text-[10.5px] text-slate-400 truncate max-w-[160px] font-semibold mt-1"
                    title={findCandidateStatus?.model ?? findCandidateDetail}
                  >
                    {findCandidateDetail}
                  </span>
                </div>
              </div>

              {/* Filter and Search toolbar */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <Input
                    placeholder="Search target path / key..."
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    className="pl-9 h-9 text-[12.5px] bg-slate-50/50 border-slate-200 focus:bg-white"
                  />
                </div>

                <Select
                  value={kindFilter}
                  onChange={(e) => {
                    setKindFilter(e.target.value as QueueTargetKindFilter);
                    setPage(1);
                  }}
                  className="w-[130px] h-9 text-[12.5px] border-slate-200 text-slate-700 bg-white"
                >
                  <option value="all">All Kinds</option>
                  <option value="wiki_file">Wiki Files</option>
                  <option value="web_ingest">Web Ingest</option>
                  <option value="vibe_memory">Vibe Memory</option>
                  <option value="knowledge_candidate">Candidates</option>
                </Select>

                <Select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value as QueueTargetStatusFilter);
                    setPage(1);
                  }}
                  className="w-[130px] h-9 text-[12.5px] border-slate-200 text-slate-700 bg-white"
                >
                  <option value="all">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="running">Running</option>
                  <option value="completed">Completed</option>
                  <option value="paused">Paused</option>
                  <option value="failed">Failed</option>
                  <option value="skipped">Skipped</option>
                </Select>
              </div>

              {/* High Density Table */}
              <div className="pt-2">
                {itemsQuery.isLoading ? (
                  <div className="text-slate-400 text-xs flex flex-col items-center justify-center py-24 gap-2">
                    <RefreshCw className="animate-spin text-slate-300 w-5 h-5" />
                    Syncing Queue Registry Index...
                  </div>
                ) : listData?.items && listData.items.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-100 text-[10.5px] uppercase font-bold text-slate-400 tracking-wider">
                          <th className="py-2.5 px-3 w-[110px]">Kind</th>
                          <th className="py-2.5 px-3">Target Details</th>
                          <th className="py-2.5 px-3 w-[100px]">Status</th>
                          <th className="py-2.5 px-3 w-[100px]">Phase</th>
                          <th className="py-2.5 px-3 w-[50px] text-center">Tries</th>
                          <th className="py-2.5 px-3 w-[100px]">Last Sync</th>
                          <th className="py-2.5 px-3 w-[70px] text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50 text-[12.5px] font-semibold text-slate-600">
                        {listData.items.map((item) => {
                          // Beautiful Light Theme Glowing border status styles
                          let statusClass = "bg-slate-50 text-slate-600 border-slate-200/60";
                          let statusLabel: string = item.status;

                          if (item.status === "completed") {
                            statusClass =
                              "bg-emerald-50 text-emerald-700 border-emerald-300/30 font-bold shadow-sm shadow-emerald-500/5";
                          } else if (item.status === "failed") {
                            statusClass =
                              "bg-rose-50 text-rose-700 border-rose-300/30 font-bold shadow-sm shadow-rose-500/5";
                          } else if (item.status === "running") {
                            statusClass =
                              "bg-amber-50 text-amber-700 border-amber-300/30 font-bold shadow-sm shadow-amber-500/5 animate-pulse";
                            statusLabel = "Active";
                          } else if (item.status === "paused") {
                            statusClass =
                              "bg-violet-50 text-violet-700 border-violet-300/20 font-bold";
                          } else if (item.status === "pending") {
                            statusClass = "bg-sky-50/50 text-sky-700 border-sky-200/20";
                          }

                          // Kind mapping
                          let kindBadgeBg = "bg-slate-50 text-slate-600 border-slate-200/50";
                          if (item.targetKind === "wiki_file") {
                            kindBadgeBg = "bg-sky-50/80 text-sky-700 border-sky-200/30";
                          } else if (item.targetKind === "web_ingest") {
                            kindBadgeBg = "bg-indigo-50/80 text-indigo-700 border-indigo-200/30";
                          } else if (item.targetKind === "vibe_memory") {
                            kindBadgeBg = "bg-emerald-50/80 text-emerald-700 border-emerald-200/30";
                          } else if (item.targetKind === "knowledge_candidate") {
                            kindBadgeBg = "bg-violet-50/80 text-violet-700 border-violet-200/30";
                          }

                          return (
                            <React.Fragment key={item.id}>
                              <tr className="hover:bg-slate-50/30 transition-colors">
                                <td className="py-2.5 px-3">
                                  <Badge
                                    variant="outline"
                                    className={`text-[9.5px] font-extrabold uppercase px-1.5 py-0 ${kindBadgeBg}`}
                                  >
                                    {item.targetKind.replace("_", " ")}
                                  </Badge>
                                </td>
                                <td className="py-2.5 px-3">
                                  <div className="flex flex-col gap-0.5">
                                    <span
                                      className="font-bold text-slate-800 break-all select-all font-mono text-[11.5px] tracking-tight"
                                      title={item.targetKey}
                                    >
                                      {item.targetKey.length > 55
                                        ? `${item.targetKey.substring(0, 55)}...`
                                        : item.targetKey}
                                    </span>
                                    <span
                                      className="text-[10.5px] text-slate-400 truncate max-w-sm font-semibold"
                                      title={item.sourceUri}
                                    >
                                      {item.sourceUri}
                                    </span>
                                  </div>
                                </td>
                                <td className="py-2.5 px-3">
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] font-extrabold py-0.5 px-2 border uppercase ${statusClass}`}
                                  >
                                    {statusLabel}
                                  </Badge>
                                </td>
                                <td className="py-2.5 px-3 text-slate-500 font-semibold text-[11.5px]">
                                  {PHASE_MAP[item.phase]?.label ?? item.phase}
                                </td>
                                <td className="py-2.5 px-3 text-center text-slate-700 font-extrabold text-[12px]">
                                  {item.attemptCount}
                                </td>
                                <td className="py-2.5 px-3 text-slate-400 font-semibold text-[11px]">
                                  {formatRelativeTime(item.updatedAt)}
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    {item.status === "running" || item.status === "pending" ? (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handlePause(item.id)}
                                        disabled={actioningId === item.id}
                                        className="h-7 w-7 p-0 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded"
                                        title="Pause processing"
                                      >
                                        <Pause size={12} />
                                      </Button>
                                    ) : item.status === "paused" ? (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handleResume(item.id)}
                                        disabled={actioningId === item.id}
                                        className="h-7 w-7 p-0 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded"
                                        title="Resume state"
                                      >
                                        <Play size={12} />
                                      </Button>
                                    ) : (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handleResume(item.id)}
                                        disabled={actioningId === item.id}
                                        className="h-7 w-7 p-0 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded"
                                        title="Requeue / Retry task"
                                      >
                                        <RotateCcw size={12} />
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              </tr>

                              {/* Glowing Red Warning drawer for failed tasks */}
                              {item.status === "failed" && item.lastError && (
                                <tr>
                                  <td
                                    colSpan={7}
                                    className="bg-rose-50/20 py-2 px-3 border-t border-slate-100"
                                  >
                                    <div className="flex items-start gap-2.5 text-[11px] text-rose-800">
                                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-rose-500 flex-shrink-0" />
                                      <div className="flex flex-col gap-0.5 w-full">
                                        <strong className="font-extrabold text-[11.5px] uppercase tracking-wider">
                                          Execution Pipeline Failure:
                                        </strong>
                                        <span className="font-mono text-[10.5px] bg-white border border-rose-100/60 p-2 rounded select-all break-all whitespace-pre-wrap leading-relaxed block text-slate-700 shadow-inner">
                                          {item.lastError}
                                        </span>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>

                    {/* Pagination Footer */}
                    {listData.total > listData.limit && (
                      <div className="flex items-center justify-between border-t border-slate-100 px-3 py-3 bg-white">
                        <span className="text-[12px] text-slate-400 font-semibold">
                          Showing{" "}
                          <strong className="font-bold text-slate-500">
                            {(page - 1) * listData.limit + 1}
                          </strong>{" "}
                          to{" "}
                          <strong className="font-bold text-slate-500">
                            {Math.min(page * listData.limit, listData.total)}
                          </strong>{" "}
                          of <strong className="font-bold text-slate-500">{listData.total}</strong>{" "}
                          targets
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={page === 1}
                            onClick={() => setPage(page - 1)}
                            className="h-8 text-[11.5px] font-bold border-slate-200 text-slate-600 rounded px-2.5"
                          >
                            Previous
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={page * listData.limit >= listData.total}
                            onClick={() => setPage(page + 1)}
                            className="h-8 text-[11.5px] font-bold border-slate-200 text-slate-600 rounded px-2.5"
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-slate-400 text-sm flex flex-col items-center justify-center py-20">
                    No registry queue items match your filter criteria.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
