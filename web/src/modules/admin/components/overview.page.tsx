import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { formatCheckedAt } from "@/lib/admin-formatters";
import {
  fetchDoctorReport,
  fetchOverviewKnowledgeAssetsDomain,
  fetchOverviewLandscapeHealthDomain,
  fetchOverviewLlmResourcesDomain,
  fetchOverviewSystemQualityDomain,
} from "../repositories/admin.repository";
import { AdminPageHeader } from "./admin-page-header";
import { KnowledgeAssetsDomain } from "./overview/knowledge-assets-domain";
import { LandscapeHealthDomain } from "./overview/landscape-health-domain";
import { LlmResourcesDomain } from "./overview/llm-resources-domain";
import { SystemQualityDomain } from "./overview/system-quality-domain";

type OverviewAccent = "emerald" | "cyan" | "violet";

function latestCheckedAt(values: Array<string | undefined>): string | undefined {
  const latest = values
    .flatMap((value) => {
      if (!value) return [];
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? [parsed] : [];
    })
    .sort((a, b) => b - a)[0];
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function accentClass(accent: OverviewAccent): string {
  if (accent === "cyan") return "accent-cyan";
  if (accent === "violet") return "accent-violet";
  return "accent-emerald";
}

function badgeClass(accent: OverviewAccent, isError: boolean): string {
  if (isError) return "border-red-500/20 text-red-700 bg-red-50/50";
  if (accent === "cyan") return "border-cyan-500/20 text-cyan-700 bg-cyan-50/50";
  if (accent === "violet") return "border-violet-500/20 text-violet-700 bg-violet-50/50";
  return "border-emerald-500/20 text-emerald-700 bg-emerald-50/50";
}

function OverviewDomainPlaceholder({
  title,
  accent,
  isError = false,
  message,
}: {
  title: string;
  accent: OverviewAccent;
  isError?: boolean;
  message?: string;
}) {
  return (
    <section
      className={`overview-domain-section ${accentClass(accent)}`}
      aria-busy={isError ? undefined : true}
    >
      <div className="overview-domain-header justify-between items-center border-b border-slate-100 pb-3">
        <div className="flex flex-col">
          <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
            {title}
          </h2>
          <span className="text-[12.5px] text-slate-400 font-medium mt-1">
            {isError ? "Load failed" : "Loading"}
          </span>
        </div>
        <Badge
          variant="outline"
          className={`text-[12px] font-bold py-0.5 px-2 ${badgeClass(accent, isError)}`}
        >
          {isError ? "Error" : "Loading"}
        </Badge>
      </div>

      {isError ? (
        <div className="text-[13px] text-red-600 leading-relaxed">{message}</div>
      ) : (
        <div className="flex flex-col gap-4 py-1">
          <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3">
            <div className="h-14 rounded bg-slate-100 animate-pulse" />
            <div className="h-14 rounded bg-slate-100 animate-pulse" />
            <div className="h-14 rounded bg-slate-100 animate-pulse" />
          </div>
          <div className="flex flex-col gap-2.5">
            <div className="h-4 w-3/4 rounded bg-slate-100 animate-pulse" />
            <div className="h-4 w-2/3 rounded bg-slate-100 animate-pulse" />
            <div className="h-40 rounded bg-slate-100 animate-pulse" />
          </div>
        </div>
      )}
    </section>
  );
}

export function OverviewPage() {
  const knowledgeAssets = useQuery({
    queryKey: ["overview-domain", "knowledge-assets"],
    queryFn: () => fetchOverviewKnowledgeAssetsDomain(),
  });
  const landscapeHealth = useQuery({
    queryKey: ["overview-domain", "landscape-health"],
    queryFn: () => fetchOverviewLandscapeHealthDomain(),
  });
  const systemQuality = useQuery({
    queryKey: ["overview-domain", "system-quality"],
    queryFn: () => fetchOverviewSystemQualityDomain(),
  });
  const llmResources = useQuery({
    queryKey: ["overview-domain", "llm-resources"],
    queryFn: () => fetchOverviewLlmResourcesDomain(),
  });
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });

  const doctorReport = doctor.data;
  const status = doctorReport?.status ?? "degraded";
  const checkedAt = latestCheckedAt([
    knowledgeAssets.data?.checkedAt,
    landscapeHealth.data?.checkedAt,
    systemQuality.data?.checkedAt,
    llmResources.data?.checkedAt,
  ]);
  const refreshDisabled =
    knowledgeAssets.isFetching ||
    landscapeHealth.isFetching ||
    systemQuality.isFetching ||
    llmResources.isFetching ||
    doctor.isFetching;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Overview"
        checkedAtText={formatCheckedAt(checkedAt)}
        onRefresh={() => {
          void Promise.all([
            knowledgeAssets.refetch(),
            landscapeHealth.refetch(),
            systemQuality.refetch(),
            llmResources.refetch(),
            doctor.refetch(),
          ]);
        }}
        refreshDisabled={refreshDisabled}
        status={status}
      />

      <div className="page-stack min-h-0 flex-1 overflow-y-auto p-4">
        <div className="overview-domain-layout">
          <div className="flex flex-col gap-6 w-full">
            {knowledgeAssets.data ? (
              <KnowledgeAssetsDomain dashboard={knowledgeAssets.data} doctorReport={doctorReport} />
            ) : (
              <OverviewDomainPlaceholder
                title="Knowledge Assets"
                accent="emerald"
                isError={knowledgeAssets.isError}
                message={errorMessage(
                  knowledgeAssets.error,
                  "/api/overview/domains/knowledge-assets response could not be loaded.",
                )}
              />
            )}

            {landscapeHealth.data ? (
              <LandscapeHealthDomain dashboard={landscapeHealth.data} />
            ) : (
              <OverviewDomainPlaceholder
                title="Knowledge Landscape Health"
                accent="emerald"
                isError={landscapeHealth.isError}
                message={errorMessage(
                  landscapeHealth.error,
                  "/api/overview/domains/landscape-health response could not be loaded.",
                )}
              />
            )}
          </div>

          <div className="flex flex-col gap-6 w-full">
            {systemQuality.data ? (
              <SystemQualityDomain dashboard={systemQuality.data} />
            ) : (
              <OverviewDomainPlaceholder
                title="System Quality & Health"
                accent="cyan"
                isError={systemQuality.isError}
                message={errorMessage(
                  systemQuality.error,
                  "/api/overview/domains/system-quality response could not be loaded.",
                )}
              />
            )}

            {llmResources.data ? (
              <LlmResourcesDomain dashboard={llmResources.data} />
            ) : (
              <OverviewDomainPlaceholder
                title="LLM Resources & Cost"
                accent="violet"
                isError={llmResources.isError}
                message={errorMessage(
                  llmResources.error,
                  "/api/overview/domains/llm-resources response could not be loaded.",
                )}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
