import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DoctorReport } from "../repositories/admin.repository";
import { AdminChartCard } from "./admin-chart-card";

const outcomeLabelMap: Record<string, string> = {
  candidate_rejected: "Rejected",
  batch_paused_circuit_breaker: "Circuit paused",
  invalid_candidate: "Invalid candidate",
  job_already_running: "Already running",
  knowledge_created: "Created",
  knowledge_deduped: "Deduped",
  llm_empty_response: "Empty response",
  llm_provider_error: "LLM provider",
  llm_timeout: "LLM timeout",
  llm_unparseable: "Unparseable",
  missing_external_evidence: "Evidence missing",
  missing_verification_tool_evidence: "Tool evidence missing",
  mixed_candidate_rejections: "Mixed rejection",
  no_candidate: "No candidate",
  processing_error: "Processing error",
  promotion_paused_backpressure: "Backpressure",
  verification_no_candidate: "Verification empty",
};

function parseReasonLabel(reason: string): string {
  return outcomeLabelMap[reason] ?? reason;
}

function shortStateLabel(raw: string): string {
  return raw.replace(/_+/g, " ");
}

function toPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function compileMixData(report: DoctorReport) {
  return [
    {
      label: "Usable",
      count: report.runs.usableRuns ?? 0,
      rate: toPercent(report.runs.usableRate),
      color: "#16a34a",
    },
    {
      label: "Warning",
      count: report.runs.warningOnlyRuns ?? 0,
      rate: toPercent(report.runs.warningOnlyRate),
      color: "#f59e0b",
    },
    {
      label: "Blocking",
      count: report.runs.blockingRuns ?? 0,
      rate: toPercent(report.runs.blockingRate),
      color: "#dc2626",
    },
    {
      label: "No content",
      count: report.runs.noContentRuns ?? 0,
      rate: toPercent(report.runs.noContentRate),
      color: "#64748b",
    },
  ];
}

function compileLatencyData(report: DoctorReport) {
  return [
    {
      label: "p50",
      durationMs:
        typeof report.runs.durationMsP50 === "number"
          ? Math.round(report.runs.durationMsP50)
          : null,
    },
    {
      label: "avg",
      durationMs:
        typeof report.runs.durationMsAvg === "number"
          ? Math.round(report.runs.durationMsAvg)
          : null,
    },
    {
      label: "p95",
      durationMs:
        typeof report.runs.durationMsP95 === "number"
          ? Math.round(report.runs.durationMsP95)
          : null,
    },
  ];
}

function distillationQueueData(report: DoctorReport) {
  return [
    {
      target: "vibe",
      queued: report.vibeDistillation.jobs.queued,
      running: report.vibeDistillation.jobs.running,
      paused: report.vibeDistillation.jobs.paused,
      failed: report.vibeDistillation.jobs.failed,
    },
    {
      target: "source",
      queued: report.sourceDistillation.jobs.queued,
      running: report.sourceDistillation.jobs.running,
      paused: report.sourceDistillation.jobs.paused,
      failed: report.sourceDistillation.jobs.failed,
    },
  ];
}

function distillationOutcomeData(report: DoctorReport) {
  const map = new Map<
    string,
    {
      reason: string;
      label: string;
      vibe: number;
      source: number;
      total: number;
    }
  >();
  for (const item of report.vibeDistillation.runs.outcomeKindCounts) {
    map.set(item.reason, {
      reason: item.reason,
      label: parseReasonLabel(item.reason),
      vibe: item.count,
      source: 0,
      total: item.count,
    });
  }
  for (const item of report.sourceDistillation.runs.outcomeKindCounts) {
    const existing = map.get(item.reason);
    if (existing) {
      existing.source = item.count;
      existing.total += item.count;
      continue;
    }
    map.set(item.reason, {
      reason: item.reason,
      label: parseReasonLabel(item.reason),
      vibe: 0,
      source: item.count,
      total: item.count,
    });
  }
  return [...map.values()].sort((left, right) => right.total - left.total).slice(0, 8);
}

function lifecycleSignalData(report: DoctorReport) {
  return [
    { label: "active", count: report.knowledgeLifecycle.activeCount },
    { label: "zero-use", count: report.knowledgeLifecycle.zeroUseActiveCount },
    { label: "stale-decay", count: report.knowledgeLifecycle.staleByDecayCount },
    { label: "stale-proc", count: report.knowledgeLifecycle.staleProcedureCount },
    { label: "stale-knowledge", count: report.mcp.staleKnowledgeCount },
    { label: "stale-source", count: report.mcp.staleSourceCount },
  ];
}

function syncFreshnessData(report: DoctorReport) {
  const states = report.agentLogSync.states;
  if (states.length === 0) {
    return [{ state: "none", cursorFiles: 0, syncAgeMinutes: 0 }];
  }
  return states.map((state) => ({
    state: shortStateLabel(state.id),
    cursorFiles: state.cursorFiles,
    syncAgeMinutes: Math.round(state.lastSyncedAgeMinutes ?? 0),
  }));
}

export function DoctorCharts({ report }: { report: DoctorReport }) {
  const mix = compileMixData(report);
  const latency = compileLatencyData(report);
  const queue = distillationQueueData(report);
  const outcomes = distillationOutcomeData(report);
  const lifecycle = lifecycleSignalData(report);
  const sync = syncFreshnessData(report);
  const hasLatency = latency.some((item) => typeof item.durationMs === "number");

  return (
    <section className="overview-chart-grid doctor-chart-grid">
      <AdminChartCard title="Compile Quality Mix">
        <div className="overview-chart-frame">
          <BarChart responsive style={{ width: "100%", height: "100%" }} data={mix}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" />
            <YAxis allowDecimals={false} />
            <Tooltip
              formatter={(value, _name, item) => [
                `${value} (${item.payload.rate})`,
                item.payload.label,
              ]}
            />
            <Legend />
            <Bar dataKey="count">
              {mix.map((item) => (
                <Cell key={item.label} fill={item.color} />
              ))}
            </Bar>
          </BarChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Compile Latency">
        {hasLatency ? (
          <div className="overview-chart-frame">
            <BarChart responsive style={{ width: "100%", height: "100%" }} data={latency}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" />
              <YAxis allowDecimals={false} />
              <Tooltip formatter={(value) => `${value}ms`} />
              <Legend />
              <Bar dataKey="durationMs" fill="#0f766e" />
            </BarChart>
          </div>
        ) : (
          <p className="state-cell">No latency data</p>
        )}
      </AdminChartCard>

      <AdminChartCard title="Distillation Queue">
        <div className="overview-chart-frame">
          <BarChart responsive style={{ width: "100%", height: "100%" }} data={queue}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="target" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="queued" stackId="queue" fill="#2563eb" />
            <Bar dataKey="running" stackId="queue" fill="#0891b2" />
            <Bar dataKey="paused" stackId="queue" fill="#64748b" />
            <Bar dataKey="failed" stackId="queue" fill="#dc2626" />
          </BarChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Distillation Outcomes">
        <div className="overview-chart-frame">
          <BarChart
            responsive
            style={{ width: "100%", height: "100%" }}
            data={
              outcomes.length > 0
                ? outcomes
                : [{ reason: "none", label: "none", vibe: 0, source: 0, total: 0 }]
            }
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" minTickGap={24} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="vibe" stackId="outcome" fill="#14b8a6" />
            <Bar dataKey="source" stackId="outcome" fill="#3b82f6" />
          </BarChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Knowledge Lifecycle Signals">
        <div className="overview-chart-frame">
          <BarChart responsive style={{ width: "100%", height: "100%" }} data={lifecycle}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" minTickGap={24} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="count" fill="#475569" />
          </BarChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Sync Freshness">
        <div className="overview-chart-frame">
          <ComposedChart responsive style={{ width: "100%", height: "100%" }} data={sync}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="state" />
            <YAxis yAxisId="files" allowDecimals={false} />
            <YAxis yAxisId="age" orientation="right" />
            <Tooltip />
            <Legend />
            <Bar yAxisId="files" dataKey="cursorFiles" fill="#2563eb" />
            <Line
              yAxisId="age"
              type="monotone"
              dataKey="syncAgeMinutes"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </div>
      </AdminChartCard>
    </section>
  );
}
