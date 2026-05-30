import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/admin-formatters";
import { cn } from "@/lib/utils";
import { HeartPulse } from "lucide-react";
import React, { useState, useEffect } from "react";
import type { OverviewSystemQualityDomain } from "../../repositories/admin.repository";
import { SystemHealthCharts } from "../overview-charts";

function formatRatePercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatCountdown(cooldownUntil: string | null, nowMs: number): string {
  if (!cooldownUntil) return "unknown";
  const untilMs = Date.parse(cooldownUntil);
  if (!Number.isFinite(untilMs)) return "unknown";
  const remainingSeconds = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  const days = Math.floor(remainingSeconds / 86_400);
  if (days > 0) {
    const hours = Math.floor((remainingSeconds % 86_400) / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  }
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

type SystemQualityDomainProps = {
  dashboard: OverviewSystemQualityDomain;
};

export function SystemQualityDomain({ dashboard }: SystemQualityDomainProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const compileRunHealth = dashboard.compileRunHealth;

  const queueTotals = (dashboard.charts.distillationQueue ?? []).reduce(
    (acc, item) => ({
      pending: acc.pending + item.pending,
      running: acc.running + item.running,
      completed: acc.completed + item.completed,
      failed: acc.failed + item.failed,
    }),
    { pending: 0, running: 0, completed: 0, failed: 0 },
  );

  const usableRate = compileRunHealth.usableRate;

  return (
    <section className="overview-domain-section accent-cyan">
      <div className="overview-domain-header justify-between items-center border-b border-cyan-500/10 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-cyan-50 rounded-lg">
            <HeartPulse
              className="overview-domain-icon text-cyan-500 w-4 h-4"
              style={{ color: "#06b6d4" }}
            />
          </div>
          <div className="flex flex-col">
            <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
              System Quality & Health
            </h2>
            <span className="text-[12.5px] text-slate-400 font-medium mt-1">
              Realtime Execution Pipelines & External API Dependencies
            </span>
          </div>
        </div>
        <Badge
          variant="outline"
          className="text-[12px] font-bold border-cyan-500/20 text-cyan-700 bg-cyan-50/50 py-0.5 px-2"
        >
          Usable Rate: {formatRatePercent(usableRate)}
        </Badge>
      </div>

      {/* 統合コンテンツエリア */}
      <div className="flex flex-col justify-between h-full py-1 gap-4">
        {/* 主要実行メトリクス (3等分スタッツ) */}
        <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Compile Usable
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatRatePercent(usableRate)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Queue Pending
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatNumber(queueTotals.pending)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Queue Running
            </span>
            <strong
              className={cn(
                "text-2xl font-extrabold mt-1 leading-none",
                queueTotals.running > 0 ? "text-amber-600 animate-pulse" : "text-slate-800",
              )}
            >
              {formatNumber(queueTotals.running)}
            </strong>
          </div>
        </div>

        {/* 📂 内訳セクション */}
        <div className="flex flex-col gap-2.5 pb-3 mb-1 border-b border-slate-100/60 text-[13px] text-slate-500 font-medium">
          {/* Queue Stats */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 items-center justify-between md:justify-start">
            <span className="text-slate-400 font-bold text-[11.5px] uppercase tracking-wider pr-0.5 w-[85px]">
              Queue Stats:
            </span>
            <div className="flex items-center gap-0.5">
              <span>Completed:</span>
              <strong className="text-slate-700">{formatNumber(queueTotals.completed)}</strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span className={queueTotals.failed > 0 ? "text-red-600" : ""}>Failed:</span>
              <strong className={queueTotals.failed > 0 ? "text-red-700" : "text-slate-700"}>
                {formatNumber(queueTotals.failed)}
              </strong>
            </div>
          </div>

          {/* Compile Runs */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 items-center justify-between md:justify-start">
            <span className="text-slate-400 font-bold text-[11.5px] uppercase tracking-wider pr-0.5 w-[85px]">
              Compile runs:
            </span>
            <div className="flex items-center gap-0.5">
              <span className="text-cyan-600">Usable:</span>
              <strong className="text-slate-700">
                {formatNumber(compileRunHealth.usableRuns ?? 0)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span className="text-amber-600">Warning:</span>
              <strong className="text-slate-700">
                {formatNumber(compileRunHealth.warningOnlyRuns ?? 0)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span className="text-red-600">Blocking:</span>
              <strong className="text-slate-700">
                {formatNumber(compileRunHealth.blockingRuns ?? 0)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span className="text-slate-400">No Content:</span>
              <strong className="text-slate-700">
                {formatNumber(compileRunHealth.noContentRuns ?? 0)}
              </strong>
            </div>
          </div>
        </div>

        {/* 🔗 外部APIステータス */}
        <div className="flex flex-col gap-1.5">
          <span className="text-slate-500 text-[12px] font-semibold uppercase tracking-wider mb-1.5">
            External Search APIs
          </span>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-slate-600 font-medium">
            {/* Brave */}
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-bold text-[11px] uppercase tracking-wider pr-0.5">
                Brave Search:
              </span>
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "w-2.5 h-2.5 rounded-full shadow-sm",
                    dashboard.searchApiStatus.brave.status === "ok"
                      ? "bg-emerald-500 shadow-emerald-500/30 animate-pulse"
                      : dashboard.searchApiStatus.brave.status === "cooldown"
                        ? "bg-amber-500"
                        : "bg-red-500",
                  )}
                />
                <span className="font-bold text-slate-700 capitalize">
                  {dashboard.searchApiStatus.brave.status === "cooldown" ? "cooldown" : "active"}
                </span>
                <strong className="text-slate-700 text-[11.5px] font-semibold ml-1">
                  {dashboard.searchApiStatus.brave.status === "cooldown"
                    ? formatCountdown(dashboard.searchApiStatus.brave.cooldownUntil, nowMs)
                    : "Ready"}
                </strong>
              </div>
            </div>
            <div className="text-slate-200">|</div>
            {/* Exa */}
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-bold text-[11px] uppercase tracking-wider pr-0.5">
                Exa Search:
              </span>
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "w-2.5 h-2.5 rounded-full shadow-sm",
                    dashboard.searchApiStatus.exa.status === "ok"
                      ? "bg-emerald-500 shadow-emerald-500/30 animate-pulse"
                      : dashboard.searchApiStatus.exa.status === "cooldown"
                        ? "bg-amber-500"
                        : "bg-red-500",
                  )}
                />
                <span className="font-bold text-slate-700 capitalize">
                  {dashboard.searchApiStatus.exa.status === "cooldown" ? "cooldown" : "active"}
                </span>
                <strong className="text-slate-700 text-[11.5px] font-semibold ml-1">
                  {dashboard.searchApiStatus.exa.status === "cooldown"
                    ? formatCountdown(dashboard.searchApiStatus.exa.cooldownUntil, nowMs)
                    : "Ready"}
                </strong>
              </div>
            </div>
          </div>
        </div>
      </div>

      <SystemHealthCharts dashboard={dashboard} />
    </section>
  );
}
