import React from "react";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/admin-formatters";
import type { OverviewLandscapeHealthDomain } from "../../repositories/admin.repository";

type LandscapeHealthDomainProps = {
  dashboard: OverviewLandscapeHealthDomain;
};

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function percentWidth(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.max(0, Math.min(100, (value / total) * 100))}%`;
}

function riskTextClass(value: number): string {
  if (value <= 0) return "text-slate-700";
  if (value < 10) return "text-amber-600";
  return "text-red-600";
}

export function LandscapeHealthDomain({ dashboard }: LandscapeHealthDomainProps) {
  const landscape = dashboard.landscape;

  if (landscape.status === "unavailable") {
    return (
      <section className="overview-domain-section accent-emerald">
        <div className="overview-domain-header justify-between items-center border-b border-emerald-500/10 pb-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-emerald-50 rounded-lg">
              <Activity className="overview-domain-icon text-emerald-500 w-4 h-4" />
            </div>
            <div className="flex flex-col">
              <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
                Knowledge Landscape Health
              </h2>
              <span className="text-[12.5px] text-slate-400 font-medium mt-1">
                Attractor, reachability, and replay stability
              </span>
            </div>
          </div>
          <Badge
            variant="outline"
            className="text-[12px] font-bold border-amber-500/20 text-amber-700 bg-amber-50/50 py-0.5 px-2"
          >
            Unavailable
          </Badge>
        </div>
        <div className="text-[13px] text-slate-500 leading-relaxed">
          Landscape summary could not be loaded for this dashboard refresh.
          <span className="sr-only"> {landscape.error}</span>
        </div>
      </section>
    );
  }

  const attractorCount =
    landscape.snapshot.strongAttractorCount + landscape.snapshot.usefulAttractorCount;
  const deadZoneCount =
    landscape.snapshot.deadZoneReachabilityCount + landscape.snapshot.deadZoneStaleCount;
  const riskCount =
    landscape.snapshot.negativeCandidateCount +
    landscape.snapshot.overSelectedNotUsedCount +
    deadZoneCount;
  const neutralCount = Math.max(
    0,
    landscape.snapshot.totalCommunities - attractorCount - riskCount,
  );
  const replayTotal =
    landscape.replay.retainedItemCount +
    landscape.replay.missingFromCurrentItemCount +
    landscape.replay.newlyRetrievedItemCount;
  const gateReviewRequired = landscape.replay.promotionGateMode === "review_required";

  return (
    <section className="overview-domain-section accent-emerald">
      <div className="overview-domain-header justify-between items-center border-b border-emerald-500/10 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-emerald-50 rounded-lg">
            <Activity
              className="overview-domain-icon text-emerald-500 w-4 h-4"
              style={{ color: "#10b981" }}
            />
          </div>
          <div className="flex flex-col">
            <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
              Knowledge Landscape Health
            </h2>
            <span className="text-[12.5px] text-slate-400 font-medium mt-1">
              Attractor, reachability, and replay stability
            </span>
          </div>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "text-[12px] font-bold py-0.5 px-2",
            gateReviewRequired
              ? "border-amber-500/20 text-amber-700 bg-amber-50/50"
              : "border-emerald-500/20 text-emerald-700 bg-emerald-50/50",
          )}
        >
          {gateReviewRequired
            ? "Gate: review required"
            : `Replay stable: ${formatPercent(landscape.replay.averageOverlapRate)}`}
        </Badge>
      </div>

      <div className="flex flex-col justify-between h-full py-1 gap-4">
        <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Attractors
            </span>
            <strong className="text-emerald-600 text-2xl font-extrabold mt-1 leading-none">
              {formatNumber(attractorCount)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Dead zones
            </span>
            <strong
              className={cn(
                "text-2xl font-extrabold mt-1 leading-none",
                riskTextClass(deadZoneCount),
              )}
            >
              {formatNumber(deadZoneCount)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Replay overlap
            </span>
            <strong
              className={cn(
                "text-2xl font-extrabold mt-1 leading-none",
                landscape.replay.averageOverlapRate < 0.6
                  ? "text-red-600"
                  : landscape.replay.averageOverlapRate < 0.8
                    ? "text-amber-600"
                    : "text-slate-800",
              )}
            >
              {formatPercent(landscape.replay.averageOverlapRate)}
            </strong>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 pb-3 mb-1 border-b border-slate-100/60 text-[13px] text-slate-500 font-medium">
          <div className="flex flex-wrap gap-x-3 gap-y-1 items-center justify-between md:justify-start">
            <span className="text-slate-400 font-bold text-[11.5px] uppercase tracking-wider pr-0.5 w-[85px]">
              Landscape:
            </span>
            <div className="flex items-center gap-0.5">
              <span className="text-emerald-600">Strong:</span>
              <strong className="text-slate-700">
                {formatNumber(landscape.snapshot.strongAttractorCount)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span>Useful:</span>
              <strong className="text-slate-700">
                {formatNumber(landscape.snapshot.usefulAttractorCount)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span className={landscape.snapshot.negativeCandidateCount > 0 ? "text-red-600" : ""}>
                Negative:
              </span>
              <strong className="text-slate-700">
                {formatNumber(landscape.snapshot.negativeCandidateCount)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span
                className={landscape.snapshot.overSelectedNotUsedCount > 0 ? "text-amber-600" : ""}
              >
                Over-selected:
              </span>
              <strong className="text-slate-700">
                {formatNumber(landscape.snapshot.overSelectedNotUsedCount)}
              </strong>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-1 items-center justify-between md:justify-start">
            <span className="text-slate-400 font-bold text-[11.5px] uppercase tracking-wider pr-0.5 w-[85px]">
              Replay:
            </span>
            <div className="flex items-center gap-0.5">
              <span>Runs:</span>
              <strong className="text-slate-700">
                {formatNumber(landscape.replay.comparedRunCount)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span
                className={landscape.replay.usedBaselineLostItemCount > 0 ? "text-amber-600" : ""}
              >
                Used lost:
              </span>
              <strong className="text-slate-700">
                {formatNumber(landscape.replay.usedBaselineLostItemCount)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span>Churn:</span>
              <strong className="text-slate-700">
                {formatNumber(landscape.replay.highChurnRunCount)}
              </strong>
            </div>
            <div className="text-slate-200">|</div>
            <div className="flex items-center gap-0.5">
              <span>No match:</span>
              <strong className="text-slate-700">
                {formatNumber(landscape.replay.currentNoMatchRunCount)}
              </strong>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3.5 text-[13px] text-slate-500">
          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-baseline text-[12.5px]">
              <span className="font-semibold text-slate-600">Field Health Mix</span>
              <span className="font-semibold text-slate-700">
                {formatNumber(landscape.snapshot.totalCommunities)} communities
              </span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-emerald-500"
                style={{ width: percentWidth(attractorCount, landscape.snapshot.totalCommunities) }}
                title={`Attractors: ${attractorCount}`}
              />
              <div
                className="h-full bg-amber-400"
                style={{
                  width: percentWidth(riskCount, landscape.snapshot.totalCommunities),
                }}
                title={`Risk: ${riskCount}`}
              />
              <div
                className="h-full bg-slate-300"
                style={{ width: percentWidth(neutralCount, landscape.snapshot.totalCommunities) }}
                title={`Other: ${neutralCount}`}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-slate-400">
              <span>Attractor {formatNumber(attractorCount)}</span>
              <span>Risk {formatNumber(riskCount)}</span>
              <span>
                Feedback thin {formatNumber(landscape.snapshot.feedbackInsufficientCount)}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-baseline text-[12.5px]">
              <span className="font-semibold text-slate-600">Replay Stability</span>
              <span className="font-semibold text-slate-700">
                retained {formatNumber(landscape.replay.retainedItemCount)}
              </span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-emerald-500"
                style={{ width: percentWidth(landscape.replay.retainedItemCount, replayTotal) }}
                title={`Retained: ${landscape.replay.retainedItemCount}`}
              />
              <div
                className="h-full bg-amber-400"
                style={{
                  width: percentWidth(landscape.replay.missingFromCurrentItemCount, replayTotal),
                }}
                title={`Missing: ${landscape.replay.missingFromCurrentItemCount}`}
              />
              <div
                className="h-full bg-sky-300"
                style={{
                  width: percentWidth(landscape.replay.newlyRetrievedItemCount, replayTotal),
                }}
                title={`New: ${landscape.replay.newlyRetrievedItemCount}`}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-[11.5px] text-slate-400">
              <span>
                missing {formatNumber(landscape.replay.missingFromCurrentItemCount)} / new{" "}
                {formatNumber(landscape.replay.newlyRetrievedItemCount)}
              </span>
              <a href="/graph" className="font-semibold text-emerald-700 hover:text-emerald-800">
                Open Graph Landscape
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
