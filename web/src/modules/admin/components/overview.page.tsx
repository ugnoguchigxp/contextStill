import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { formatCheckedAt } from "@/lib/admin-formatters";
import { fetchDoctorReport, fetchOverviewDashboard } from "../repositories/admin.repository";
import { AdminPageHeader } from "./admin-page-header";
import { KnowledgeAssetsDomain } from "./overview/knowledge-assets-domain";
import { SystemQualityDomain } from "./overview/system-quality-domain";
import { LlmResourcesDomain } from "./overview/llm-resources-domain";

export function OverviewPage() {
  const overview = useQuery({
    queryKey: ["overview-dashboard"],
    queryFn: () => fetchOverviewDashboard(),
  });
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });

  const dashboard = overview.data;
  const doctorReport = doctor.data;
  const status = doctorReport?.status ?? "degraded";

  const overviewErrorMessage =
    overview.error instanceof Error
      ? overview.error.message
      : "/api/overview response could not be loaded.";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Overview"
        checkedAtText={formatCheckedAt(dashboard?.checkedAt)}
        onRefresh={() => {
          void Promise.all([overview.refetch(), doctor.refetch()]);
        }}
        refreshDisabled={overview.isFetching || doctor.isFetching}
        status={status}
      />

      <div className="page-stack min-h-0 flex-1 overflow-y-auto p-4">
        {overview.isError ? (
          <Card>
            <CardContent className="metric-card">
              <span className="metric-label text-red-600">Overview API Error</span>
              <strong className="metric-value">{overviewErrorMessage}</strong>
              <span className="metric-hint">
                Existing dashboard data remains visible when it is available.
              </span>
            </CardContent>
          </Card>
        ) : null}

        {dashboard ? (
          <div className="overview-domain-layout">
            {/* 📂 左カラム: Knowledge Assets (統計とチャート) */}
            <div className="flex flex-col gap-6 w-full">
              <KnowledgeAssetsDomain dashboard={dashboard} doctorReport={doctorReport} />
            </div>

            {/* 📂 右カラム: System Quality & Health ＆ LLM Resources & Cost を縦並びに */}
            <div className="flex flex-col gap-6 w-full">
              <SystemQualityDomain dashboard={dashboard} doctorReport={doctorReport} />
              <LlmResourcesDomain dashboard={dashboard} />
            </div>
          </div>
        ) : (
          <div className="text-slate-400 text-sm flex items-center justify-center py-20">
            Loading Dashboard Data...
          </div>
        )}
      </div>
    </div>
  );
}
