import { Activity, Clock, Cpu, Database, Pause } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DistillationTargetState } from "../repositories/admin.repository";
import { STEPS_IN_PIPELINE, formatRelativeTime } from "./queue.page.helpers";

type QueueTelemetryPanelProps = {
  activeTasks: DistillationTargetState[];
  actioningId: string | null;
  totalItems: number;
  stats: Record<string, number>;
  onPause: (id: string) => void;
};

export function QueueTelemetryPanel({
  activeTasks,
  actioningId,
  totalItems,
  stats,
  onPause,
}: QueueTelemetryPanelProps) {
  return (
    <section className="overview-domain-section accent-cyan shadow-sm">
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

      <div className="flex flex-col gap-4 pt-1">
        {activeTasks.length > 0 ? (
          activeTasks.map((task) => {
            const activeStepIndex = STEPS_IN_PIPELINE.findIndex((s) => s.key === task.phase);
            return (
              <div key={task.id} className="space-y-4">
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
                      <span>Model:</span>
                      <span
                        className="truncate max-w-[160px] font-mono text-[10.5px]"
                        title={task.activeModel ?? undefined}
                      >
                        {task.activeModel ?? "unknown"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 pl-1">
                  <span className="text-[12.5px] font-bold text-slate-700 tracking-wide uppercase">
                    Pipeline Progress
                  </span>
                  <div className="relative border-l-2 border-slate-100 ml-2 pl-4 space-y-4 pt-1">
                    {STEPS_IN_PIPELINE.map((step, idx) => {
                      const isCompleted = idx < activeStepIndex;
                      const isActive = idx === activeStepIndex;
                      let stepDotColor = "bg-slate-200 border-slate-300";
                      let stepTextColor = "text-slate-400 font-medium";
                      let stepBgClass = "bg-slate-100";
                      if (isCompleted) {
                        stepDotColor = "bg-cyan-500 border-cyan-400 shadow-sm shadow-cyan-500/20";
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
                          <span
                            className={`absolute -left-[23px] top-1.5 w-2 h-2 rounded-full border ${stepDotColor}`}
                          />
                          <div className="flex items-baseline justify-between">
                            <span className={`text-[12.5px] ${stepTextColor}`}>{step.label}</span>
                            {isActive && (
                              <span className="text-[11.5px] font-bold text-amber-600 animate-pulse">
                                active
                              </span>
                            )}
                          </div>
                          <div className="w-full h-1 bg-slate-100/80 rounded-full overflow-hidden flex">
                            <div
                              className={`h-full ${stepBgClass} transition-all duration-300`}
                              style={{ width: isCompleted ? "100%" : isActive ? "65%" : "0%" }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-slate-100/60 text-[11.5px] text-slate-400 font-semibold">
                  <div className="flex items-center gap-1">
                    <Clock size={12} className="text-slate-300" />
                    <span>Heartbeat: {formatRelativeTime(task.heartbeatAt)}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onPause(task.id)}
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
              No active distillation locks. Watching database for new code vibes or changes...
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
