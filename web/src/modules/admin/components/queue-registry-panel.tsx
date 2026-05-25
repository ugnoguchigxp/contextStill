import React from "react";
import { AlertCircle, Layers, Pause, Play, RefreshCw, RotateCcw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  DistillationTargetState,
  QueueDashboardStats,
  QueueListResponse,
  QueueTargetKindFilter,
  QueueTargetStatusFilter,
} from "../repositories/admin.repository";
import {
  PHASE_MAP,
  formatRelativeTime,
  kindBadgeStyle,
  statusBadgeStyle,
} from "./queue.page.helpers";

type QueueRegistryPanelProps = {
  stats: Record<string, number>;
  maxAttempts: number;
  findCandidateState: QueueDashboardStats["findCandidate"]["status"] | "idle";
  findCandidateWaiting: boolean;
  findCandidateRunning: boolean;
  findCandidateLabel: string;
  findCandidateDetail: string;
  findCandidateModel?: string | null;
  search: string;
  setSearch: (value: string) => void;
  kindFilter: QueueTargetKindFilter;
  setKindFilter: (value: QueueTargetKindFilter) => void;
  statusFilter: QueueTargetStatusFilter;
  setStatusFilter: (value: QueueTargetStatusFilter) => void;
  page: number;
  setPage: (value: number) => void;
  listData?: QueueListResponse;
  itemsLoading: boolean;
  actioningId: string | null;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
};

function actionButton(
  item: DistillationTargetState,
  actioningId: string | null,
  maxAttempts: number,
  onPause: (id: string) => void,
  onResume: (id: string) => void,
) {
  if (item.attemptCount >= maxAttempts && item.status !== "running") {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        className="h-7 w-7 p-0 text-slate-300 rounded"
        title="Retry limit reached"
      >
        <RotateCcw size={12} />
      </Button>
    );
  }
  if (item.status === "running" || item.status === "pending") {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onPause(item.id)}
        disabled={actioningId === item.id}
        className="h-7 w-7 p-0 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded"
        title="Pause processing"
      >
        <Pause size={12} />
      </Button>
    );
  }
  if (item.status === "paused") {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onResume(item.id)}
        disabled={actioningId === item.id}
        className="h-7 w-7 p-0 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded"
        title="Resume state"
      >
        <Play size={12} />
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onResume(item.id)}
      disabled={actioningId === item.id}
      className="h-7 w-7 p-0 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded"
      title="Requeue / Retry task"
    >
      <RotateCcw size={12} />
    </Button>
  );
}

export function QueueRegistryPanel({
  stats,
  maxAttempts,
  findCandidateState,
  findCandidateWaiting,
  findCandidateRunning,
  findCandidateLabel,
  findCandidateDetail,
  findCandidateModel,
  search,
  setSearch,
  kindFilter,
  setKindFilter,
  statusFilter,
  setStatusFilter,
  page,
  setPage,
  listData,
  itemsLoading,
  actioningId,
  onPause,
  onResume,
}: QueueRegistryPanelProps) {
  return (
    <section className="overview-domain-section accent-violet shadow-sm bg-white">
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
            title={findCandidateModel ?? findCandidateDetail}
          >
            {findCandidateDetail}
          </span>
        </div>
      </div>

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

      <div className="pt-2">
        {itemsLoading ? (
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
                  const status = statusBadgeStyle(item);
                  const kindClass = kindBadgeStyle(item.targetKind);
                  return (
                    <React.Fragment key={item.id}>
                      <tr className="hover:bg-slate-50/30 transition-colors">
                        <td className="py-2.5 px-3">
                          <Badge
                            variant="outline"
                            className={`text-[9.5px] font-extrabold uppercase px-1.5 py-0 ${kindClass}`}
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
                            className={`text-[10px] font-extrabold py-0.5 px-2 border uppercase ${status.className}`}
                          >
                            {status.label}
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
                            {actionButton(item, actioningId, maxAttempts, onPause, onResume)}
                          </div>
                        </td>
                      </tr>
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
                  of <strong className="font-bold text-slate-500">{listData.total}</strong> targets
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
  );
}
