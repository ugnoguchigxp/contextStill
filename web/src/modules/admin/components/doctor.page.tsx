import React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatCheckedAt, formatNumber } from "@/lib/admin-formatters";
import { useQuery } from "@tanstack/react-query";
import { fetchDoctorReport } from "../repositories/admin.repository";
import { AdminPageHeader } from "./admin-page-header";
import { Database, Cpu, Activity } from "lucide-react";
import {
  getDoctorReasonDetails,
  getEmergencySignals,
  getDomainSignals,
  getDomainNextActions,
  SlimDoctorReasonList,
  EmergencyBanner,
} from "./doctor-signals";

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}ms`;
}

function formatAgeMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (value < 60) return `${Math.round(value)} min`;
  if (value < 60 * 48) return `${(value / 60).toFixed(1)} h`;
  return `${(value / 60 / 24).toFixed(1)} d`;
}

function launchAgentLabel(agent: { loaded: boolean; installed: boolean }): string {
  if (agent.loaded) return "loaded";
  if (agent.installed) return "installed";
  return "not installed";
}

export function DoctorPage() {
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });
  const report = doctor.data;
  const status = report?.status ?? "degraded";
  const reasonDetails = getDoctorReasonDetails(report);

  // 1. 各カテゴリへの分類
  const emergencySignals = getEmergencySignals(reasonDetails);
  
  const infraSignals = getDomainSignals(reasonDetails, "infrastructure");
  const aiSignals = getDomainSignals(reasonDetails, "ai");
  const pipelineSignals = getDomainSignals(reasonDetails, "pipeline");

  const aiNextActions = getDomainNextActions(report, "ai");
  const pipelineNextActions = getDomainNextActions(report, "pipeline");

  // 主要メトリクスの計算（既存ロジック）
  const queuePending = report
    ? report.vibeDistillation.jobs.queued + report.sourceDistillation.jobs.queued
    : null;
  const queueRunning = report
    ? report.vibeDistillation.jobs.running + report.sourceDistillation.jobs.running
    : null;
  const maxSyncAge = report
    ? report.agentLogSync.states.length > 0
      ? Math.max(...report.agentLogSync.states.map((item) => item.lastSyncedAgeMinutes ?? 0))
      : null
    : null;
  const syncStaleThresholdMinutes = report?.runs.freshnessThresholdMinutes ?? 720;
  const staleSyncCount = report
    ? report.agentLogSync.states.filter(
        (state) => (state.lastSyncedAgeMinutes ?? 0) > syncStaleThresholdMinutes,
      ).length
    : null;
  const missingTables = report?.tables?.missing.length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Doctor"
        checkedAtText={formatCheckedAt(report?.checkedAt)}
        onRefresh={() => {
          void doctor.refetch();
        }}
        refreshDisabled={doctor.isFetching}
        status={status}
      />

      <div className="page-stack min-h-0 flex-1 overflow-y-auto p-4">
        {doctor.isError ? (
          <Card>
            <CardContent className="metric-card">
              <span className="metric-label text-red-600">Doctor API Error</span>
              <strong className="metric-value">/api/doctor response could not be loaded.</strong>
            </CardContent>
          </Card>
        ) : report ? (
          <>
            {/* 🚨 緊急バナー */}
            <EmergencyBanner reasons={emergencySignals} />

            {/* 📂 ドメインレイアウト（Overviewと同様の2カラム） */}
            <div className="overview-domain-layout">
              
              {/* 📂 左カラム: Core Infrastructure (Emerald) */}
              <div className="flex flex-col gap-6 w-full">
                <section className="overview-domain-section accent-emerald">
                  <div className="overview-domain-header justify-between items-center border-b border-emerald-500/10 pb-3">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-emerald-50 rounded-lg">
                        <Database className="overview-domain-icon text-emerald-500 w-4 h-4" style={{ color: "#10b981" }} />
                      </div>
                      <div className="flex flex-col">
                        <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
                          Core Infrastructure
                        </h2>
                        <span className="text-[12.5px] text-slate-400 font-medium mt-1">
                          Database & Vector Engine Health
                        </span>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[12px] font-bold border-emerald-500/20 text-emerald-700 bg-emerald-50/50 py-0.5 px-2">
                      Latency: {formatDurationMs(report.db.durationMs)}
                    </Badge>
                  </div>

                  {/* コンテンツ */}
                  <div className="flex flex-col justify-between h-full py-1 gap-4">
                    {/* 3等分スタッツ */}
                    <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          DB Status
                        </span>
                        <strong className={`text-2xl font-extrabold mt-1 leading-none ${report.db.reachable ? "text-emerald-600" : "text-red-600"}`}>
                          {report.db.reachable ? "Online" : "Offline"}
                        </strong>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          DB Latency
                        </span>
                        <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
                          {formatDurationMs(report.db.durationMs)}
                        </strong>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          pgvector
                        </span>
                        <strong className={`text-2xl font-extrabold mt-1 leading-none ${report.vector.installed ? "text-emerald-600" : "text-amber-600"}`}>
                          {report.vector.installed ? "Installed" : "Missing"}
                        </strong>
                      </div>
                    </div>

                    {/* 詳細リスト */}
                    <div className="flex flex-col gap-2.5 pb-2 text-[13px] text-slate-500 font-medium">
                      <div className="flex items-center justify-between">
                        <span>Required Tables</span>
                        <strong className={missingTables > 0 ? "text-red-600" : "text-slate-700"}>
                          {missingTables > 0 ? `Missing ${missingTables}` : "OK"}
                        </strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Embedding Daemon</span>
                        <strong className={report.embedding?.daemon.reachable ? "text-emerald-600" : "text-amber-600"}>
                          {report.embedding?.daemon.reachable ? "Reachable" : "Offline"}
                        </strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Embedding CLI</span>
                        <strong className={report.embedding?.cli.usable ? "text-emerald-600" : "text-amber-600"}>
                          {report.embedding?.cli.usable ? "Usable" : "Unavailable"}
                        </strong>
                      </div>
                    </div>

                    {/* インラインシグナル */}
                    <SlimDoctorReasonList reasons={infraSignals} />
                  </div>
                </section>
              </div>

              {/* 📂 右カラム: AI & Service Tools ＆ Pipeline & Automation を縦並びに */}
              <div className="flex flex-col gap-6 w-full">
                
                {/* 🟣 AI & Service Tools (Violet) */}
                <section className="overview-domain-section accent-violet">
                  <div className="overview-domain-header justify-between items-center border-b border-violet-500/10 pb-3">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-violet-50 rounded-lg">
                        <Cpu className="overview-domain-icon text-violet-500 w-4 h-4" style={{ color: "#8b5cf6" }} />
                      </div>
                      <div className="flex flex-col">
                        <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
                          AI & Service Tools
                        </h2>
                        <span className="text-[12.5px] text-slate-400 font-medium mt-1">
                          LLM & MCP Tool Integrations
                        </span>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[12px] font-bold border-violet-500/20 text-violet-700 bg-violet-50/50 py-0.5 px-2">
                      Tools: {report.mcp.exposedTools.length} Exposed
                    </Badge>
                  </div>

                  {/* コンテンツ */}
                  <div className="flex flex-col justify-between h-full py-1 gap-4">
                    {/* 3等分スタッツ */}
                    <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          Agentic LLM
                        </span>
                        <strong className={`text-[19px] font-extrabold mt-1 leading-none ${report.agenticLlm?.reachable ? "text-violet-600" : "text-amber-600"}`}>
                          {report.agenticLlm?.reachable ? "Reachable" : report.agenticLlm?.configured ? "Offline" : "Unconfigured"}
                        </strong>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          MCP Tools
                        </span>
                        <strong className={`text-2xl font-extrabold mt-1 leading-none ${report.mcp.missingPrimaryTools.length > 0 ? "text-amber-600" : "text-violet-600"}`}>
                          {report.mcp.missingPrimaryTools.length > 0 ? `Missing ${report.mcp.missingPrimaryTools.length}` : "OK"}
                        </strong>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          Stale Assets
                        </span>
                        <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
                          {report.mcp.staleKnowledgeCount + report.mcp.staleSourceCount}
                        </strong>
                      </div>
                    </div>

                    {/* 詳細リスト */}
                    <div className="flex flex-col gap-2.5 pb-2 text-[13px] text-slate-500 font-medium">
                      <div className="flex items-center justify-between">
                        <span>LLM Provider</span>
                        <strong className="text-slate-700 capitalize">{report.agenticLlm?.provider || "None"}</strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>LLM Model</span>
                        <strong className="text-slate-700 text-xs truncate max-w-[150px]" title={report.agenticLlm?.model}>{report.agenticLlm?.model || "None"}</strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Required MCP Tools</span>
                        <strong className="text-slate-700">{report.mcp.requiredPrimaryTools.length} loaded</strong>
                      </div>
                    </div>

                    {/* インラインシグナル */}
                    <SlimDoctorReasonList reasons={aiSignals} />

                    {/* インライン Next Actions */}
                    {aiNextActions.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-slate-100 flex flex-col gap-1.5">
                        <div className="text-[12px] font-bold text-violet-600 uppercase tracking-wider">
                          AI 推奨アクション:
                        </div>
                        {aiNextActions.map((action, idx) => (
                          <div key={idx} className="text-[12px] text-slate-600 bg-violet-50/30 border border-violet-100 rounded p-2">
                            {action}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                {/* 🔵 Pipeline & Automation (Cyan) */}
                <section className="overview-domain-section accent-cyan">
                  <div className="overview-domain-header justify-between items-center border-b border-cyan-500/10 pb-3">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-cyan-50 rounded-lg">
                        <Activity className="overview-domain-icon text-cyan-500 w-4 h-4" style={{ color: "#06b6d4" }} />
                      </div>
                      <div className="flex flex-col">
                        <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
                          Pipeline & Automation
                        </h2>
                        <span className="text-[12.5px] text-slate-400 font-medium mt-1">
                          Log Sync & Distillation Pipelines
                        </span>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[12px] font-bold border-cyan-500/20 text-cyan-700 bg-cyan-50/50 py-0.5 px-2">
                      Sync Freshness: {formatAgeMinutes(maxSyncAge)}
                    </Badge>
                  </div>

                  {/* コンテンツ */}
                  <div className="flex flex-col justify-between h-full py-1 gap-4">
                    {/* 3等分スタッツ */}
                    <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          Sync Status
                        </span>
                        <strong className={`text-2xl font-extrabold mt-1 leading-none ${staleSyncCount > 0 ? "text-amber-600" : "text-cyan-600"}`}>
                          {staleSyncCount > 0 ? "Stale" : "Fresh"}
                        </strong>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          Queue Pending
                        </span>
                        <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
                          {formatNumber(queuePending)}
                        </strong>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
                          Queue Running
                        </span>
                        <strong className={`text-2xl font-extrabold mt-1 leading-none ${queueRunning > 0 ? "text-amber-600 animate-pulse" : "text-slate-800"}`}>
                          {formatNumber(queueRunning)}
                        </strong>
                      </div>
                    </div>

                    {/* 詳細リスト */}
                    <div className="flex flex-col gap-2.5 pb-2 text-[13px] text-slate-500 font-medium">
                      <div className="flex justify-between items-center">
                        <span>Log Sync Agent</span>
                        <strong className="capitalize">{report ? launchAgentLabel(report.agentLogSync.launchAgent) : "-"}</strong>
                      </div>
                      <div className="flex justify-between items-center">
                        <span>Vibe Distill Agent</span>
                        <strong className="capitalize">{report ? launchAgentLabel(report.vibeDistillation.launchAgent) : "-"}</strong>
                      </div>
                      <div className="flex justify-between items-center">
                        <span>Source Distill Agent</span>
                        <strong className="capitalize">{report ? launchAgentLabel(report.sourceDistillation.launchAgent) : "-"}</strong>
                      </div>
                      <div className="flex justify-between items-center">
                        <span>Vibe/Source Locks</span>
                        <strong className="text-slate-700">
                          Vibe: {report.vibeDistillation.queueHealth.lock.exists ? "Held" : "Clear"} / 
                          Source: {report.sourceDistillation.queueHealth.lock.exists ? "Held" : "Clear"}
                        </strong>
                      </div>
                    </div>

                    {/* インラインシグナル */}
                    <SlimDoctorReasonList reasons={pipelineSignals} />

                    {/* インライン Next Actions */}
                    {pipelineNextActions.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-slate-100 flex flex-col gap-1.5">
                        <div className="text-[12px] font-bold text-cyan-600 uppercase tracking-wider">
                          パイプライン推奨アクション:
                        </div>
                        {pipelineNextActions.map((action, idx) => (
                          <div key={idx} className="text-[12px] text-slate-600 bg-cyan-50/30 border border-cyan-100 rounded p-2">
                            {action}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

              </div>
            </div>
          </>
        ) : (
          <div className="text-slate-400 text-sm flex items-center justify-center py-20">
            Loading Doctor Report...
          </div>
        )}
      </div>
    </div>
  );
}
