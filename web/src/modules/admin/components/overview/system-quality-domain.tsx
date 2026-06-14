import { Badge } from "@/components/ui/badge";
import { formatNumber, formatPercent } from "@/lib/admin-formatters";
import { cn } from "@/lib/utils";
import { HeartPulse } from "lucide-react";
import React, { useState, useEffect } from "react";
import type { OverviewSystemQualityDomain } from "../../repositories/admin.repository";
import { SystemHealthCharts } from "../overview-charts";

function formatScore(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(1);
}

function formatProductMetricValue(
  metric: OverviewSystemQualityDomain["productValueStats"]["metrics"][number],
): string {
  if (typeof metric.rate === "number") return formatPercent(metric.rate);
  return formatNumber(metric.count);
}

function formatProductMetricEvidence(
  metric: OverviewSystemQualityDomain["productValueStats"]["metrics"][number],
): string {
  if (metric.denominator <= 0) return `${formatNumber(metric.count)} signals`;
  return `${formatNumber(metric.count)} / ${formatNumber(metric.denominator)}`;
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

  const compileEvalStats = dashboard.compileEvalStats;
  const productValueStats = dashboard.productValueStats;

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
          Eval Avg: {formatScore(compileEvalStats.averageAvg)} ({compileEvalStats.windowLabel})
        </Badge>
      </div>

      {/* 統合コンテンツエリア */}
      <div className="flex flex-col justify-between h-full py-1 gap-4">
        {/* 主要実行メトリクス (3等分スタッツ) */}
        <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Compile Avg Score
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatScore(compileEvalStats.averageAvg)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Feedback Count
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatNumber(compileEvalStats.evaluationCount)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Evaluated Runs
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatNumber(compileEvalStats.evaluatedRunCount)}
            </strong>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 border-b border-slate-100/60 pb-3 mb-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500 text-[12px] font-semibold uppercase">
              Product Value Evidence
            </span>
            <span className="text-[12px] text-slate-400 font-medium">
              {productValueStats.windowLabel}
            </span>
          </div>
          <div className="grid grid-cols-2 xl:grid-cols-5 gap-2">
            {productValueStats.metrics.map((metric) => (
              <div
                key={metric.metric}
                className="rounded-md border border-cyan-500/10 bg-cyan-50/30 px-2.5 py-2 min-w-0"
              >
                <span className="block text-[11.5px] text-slate-500 font-semibold truncate">
                  {metric.label}
                </span>
                <strong className="block text-slate-800 text-[20px] leading-tight font-extrabold mt-1">
                  {formatProductMetricValue(metric)}
                </strong>
                <span className="block text-[11.5px] text-slate-500 mt-1">
                  {formatProductMetricEvidence(metric)}
                </span>
                <span className="block text-[11px] text-slate-400 leading-snug mt-0.5">
                  {metric.evidenceLabel}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 📂 内訳セクション */}
        <div className="flex flex-col gap-2.5 pb-3 mb-1 border-b border-slate-100/60 text-[13px] text-slate-500 font-medium">
          {/* Compile Eval */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 items-center justify-between md:justify-start">
            <span className="text-slate-400 font-bold text-[11.5px] uppercase tracking-wider pr-0.5 w-[85px]">
              Eval Stats:
            </span>
            <div className="flex items-center gap-0.5">
              <span>Window:</span>
              <strong className="text-slate-700">{compileEvalStats.windowLabel}</strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span className="text-cyan-600">Avg:</span>
              <strong className="text-slate-700">{formatScore(compileEvalStats.averageAvg)}</strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span>Feedback:</span>
              <strong className="text-slate-700">
                {formatNumber(compileEvalStats.evaluationCount)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span>Runs:</span>
              <strong className="text-slate-700">
                {formatNumber(compileEvalStats.evaluatedRunCount)}
              </strong>
            </div>
          </div>

          {/* Compile Runs */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 items-center justify-between md:justify-start">
            <span className="text-slate-400 font-bold text-[11.5px] uppercase tracking-wider pr-0.5 w-[85px]">
              Compile:
            </span>
            <div className="flex items-center gap-0.5">
              <span className="text-emerald-600">Ok:</span>
              <strong className="text-slate-700">
                {formatNumber(dashboard.kpis.compileOkRuns)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span className="text-amber-600">Degraded:</span>
              <strong className="text-slate-700">
                {formatNumber(dashboard.kpis.compileDegradedRuns)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span className="text-red-600">Failed:</span>
              <strong className="text-slate-700">
                {formatNumber(dashboard.kpis.compileFailedRuns)}
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
