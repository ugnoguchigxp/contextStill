import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/admin-formatters";
import { CreditCard } from "lucide-react";
import React from "react";
import type { OverviewLlmResourcesDomain } from "../../repositories/admin.repository";
import { LlmCharts } from "../overview-charts";

function formatJpy(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: value < 1 ? 2 : 0,
  }).format(value);
}

type LlmResourcesDomainProps = {
  dashboard: OverviewLlmResourcesDomain;
};

export function LlmResourcesDomain({ dashboard }: LlmResourcesDomainProps) {
  return (
    <section className="overview-domain-section accent-violet">
      <div className="overview-domain-header justify-between items-center border-b border-violet-500/10 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-violet-50 rounded-lg">
            <CreditCard
              className="overview-domain-icon text-violet-500 w-4 h-4"
              style={{ color: "#8b5cf6" }}
            />
          </div>
          <div className="flex flex-col">
            <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
              LLM Resources & Cost
            </h2>
            <span className="text-[12.5px] text-slate-400 font-medium mt-1">
              Token Volume, Financial Cost & Active Source Breakdown
            </span>
          </div>
        </div>
        <Badge
          variant="outline"
          className="text-[12px] font-bold border-violet-500/20 text-violet-700 bg-violet-50/50 py-0.5 px-2"
        >
          Coverage: {dashboard.llmUsage.kpis.measuredCoveragePercent30d.toFixed(1)}%
        </Badge>
      </div>

      {/* 統合コンテンツエリア */}
      <div className="flex flex-col justify-between h-full py-1 gap-4">
        {/* 主要3大スタッツ */}
        <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Cloud LLM Cost 30d
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatJpy(dashboard.llmUsage.kpis.cloudCostJpyTotal30d)}
            </strong>
            <span className="text-[11px] text-slate-400 mt-1">
              {dashboard.llmUsage.kpis.cloudModel || "Gemini"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Cloud LLM 30d
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatNumber(dashboard.llmUsage.kpis.cloudTokensTotal30d)}
            </strong>
            <span className="text-[11px] text-slate-400 mt-1">
              in {formatNumber(dashboard.llmUsage.kpis.cloudPromptTokens30d)} / out{" "}
              {formatNumber(dashboard.llmUsage.kpis.cloudCompletionTokens30d)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Local LLM 30d
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatNumber(dashboard.llmUsage.kpis.localTokensTotal30d)}
            </strong>
            <span className="text-[11px] text-slate-400 mt-1">
              in {formatNumber(dashboard.llmUsage.kpis.localPromptTokens30d)} / out{" "}
              {formatNumber(dashboard.llmUsage.kpis.localCompletionTokens30d)}
            </span>
          </div>
        </div>

        {/* 📂 補助メトリクス行 */}
        <div className="flex flex-col gap-2.5 pb-3 mb-1 border-b border-slate-100/60 text-[13px] text-slate-500 font-medium">
          <div className="flex flex-wrap gap-x-3 gap-y-1 items-center justify-between md:justify-start">
            <span className="text-slate-400 font-bold text-[11.5px] uppercase tracking-wider pr-0.5 w-[95px]">
              LLM measured:
            </span>
            <div className="flex items-center gap-0.5">
              <span>Measured Coverage:</span>
              <strong className="text-slate-700">
                {dashboard.llmUsage.kpis.measuredCoveragePercent30d.toFixed(1)}%
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span>Calls:</span>
              <strong className="text-slate-700">
                measured {formatNumber(dashboard.llmUsage.kpis.measuredCalls30d)} / total{" "}
                {formatNumber(dashboard.llmUsage.kpis.estimatedCalls30d)}
              </strong>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-1 items-center justify-between md:justify-start">
            <span className="text-slate-400 font-bold text-[11.5px] uppercase tracking-wider pr-0.5 w-[95px]">
              Estimates:
            </span>
            <div className="flex items-center gap-0.5">
              <span>Estimated Tokens:</span>
              <strong className="text-slate-700">
                {formatNumber(dashboard.llmUsage.kpis.estimatedTokensTotal30d)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span>Measured Total:</span>
              <strong className="text-slate-700">
                {formatNumber(dashboard.llmUsage.kpis.measuredTokensTotal30d)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span>Total Calls:</span>
              <strong className="text-slate-700">
                {formatNumber(dashboard.llmUsage.kpis.totalCalls30d)}
              </strong>
            </div>
          </div>
        </div>

        {/* 📊 LLM Activity Sources ランキング */}
        <div className="flex flex-col gap-2">
          <span className="text-slate-500 text-[12px] font-semibold uppercase tracking-wider mb-1.5">
            LLM Activity Sources (30d)
          </span>
          {(() => {
            const sources = dashboard.llmUsage.bySource ?? [];
            const maxTokens = Math.max(...sources.map((s) => s.totalTokens), 1);
            if (sources.length === 0) {
              return <div className="text-[12px] text-slate-400">No active LLM sources</div>;
            }
            return (
              <div className="flex flex-col gap-2">
                {sources.map((item, index) => {
                  const pct = (item.totalTokens / maxTokens) * 100;
                  // 綺麗な HSL 系の色相を振る
                  const hue = (260 + index * 40) % 360;
                  return (
                    <div key={item.source} className="flex flex-col gap-1">
                      <div className="flex justify-between text-[12px] font-semibold text-slate-600">
                        <span>{item.source}</span>
                        <span className="text-slate-400 font-medium">
                          {formatNumber(item.calls)} calls / {formatNumber(item.totalTokens)} tokens
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500 ease-out"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: `hsl(${hue}, 70%, 65%)`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>

      <LlmCharts dashboard={dashboard} />
    </section>
  );
}
