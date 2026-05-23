import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DoctorReport, OverviewDashboard } from "../repositories/admin.repository";
import { AdminChartCard } from "./admin-chart-card";

const knowledgeStatusLabel: Record<"active" | "draft" | "deprecated", string> = {
  active: "active",
  draft: "draft",
  deprecated: "deprecated",
};

const distillationLabel: Record<"wiki_file" | "vibe_memory" | "knowledge_candidate", string> = {
  knowledge_candidate: "candidate",
  wiki_file: "wiki",
  vibe_memory: "vibe",
};

function roundDuration(value: number | null): string {
  if (value === null || value === undefined) return "-";
  return `${Math.round(value)}ms`;
}

function parseNullableDuration(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCompactNumber(value: unknown): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    parseNumber(value),
  );
}

function formatJpy(value: unknown): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: parseNumber(value) < 1 ? 2 : 0,
  }).format(parseNumber(value));
}

const llmTooltipLabel: Record<string, string> = {
  localTokens: "local tokens",
  cloudTokens: "cloud tokens",
  totalTokens: "total tokens",
  costJpy: "cloud cost",
};

function toPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value / 1000).toFixed(1)}s`;
}

function compileMixData(report: DoctorReport | null | undefined) {
  if (!report) return [];
  return [
    {
      label: "usable",
      count: report.runs.usableRuns ?? 0,
      rate: toPercent(report.runs.usableRate),
      color: "#16a34a",
    },
    {
      label: "warning",
      count: report.runs.warningOnlyRuns ?? 0,
      rate: toPercent(report.runs.warningOnlyRate),
      color: "#f59e0b",
    },
    {
      label: "blocking",
      count: report.runs.blockingRuns ?? 0,
      rate: toPercent(report.runs.blockingRate),
      color: "#dc2626",
    },
    {
      label: "no content",
      count: report.runs.noContentRuns ?? 0,
      rate: toPercent(report.runs.noContentRate),
      color: "#64748b",
    },
  ];
}

function compileLatencyData(report: DoctorReport | null | undefined) {
  const samples = report?.runs.durationSamples ?? [];
  if (samples.length === 0) return [];
  const maxBucketSec = Math.max(
    1,
    ...samples.map((sample) => Math.floor(sample.durationMs / 1000) + 1),
  );
  const buckets = Array.from({ length: maxBucketSec }, (_, index) => ({
    label: `${index}-${index + 1}s`,
    count: 0,
  }));

  for (const sample of samples) {
    const index = Math.min(Math.floor(sample.durationMs / 1000), buckets.length - 1);
    const bucket = buckets[index];
    if (bucket) bucket.count += 1;
  }

  return buckets;
}

function averageLatencyBucketLabel(value: number | null): string | null {
  if (value === null) return null;
  const bucketStart = Math.floor(value / 1000);
  return `${bucketStart}-${bucketStart + 1}s`;
}

function knowledgeUsageLifecycleData(report: DoctorReport | null | undefined) {
  if (!report) return [];
  const activeCount = report.knowledgeLifecycle.activeCount;
  const zeroUseCount = report.knowledgeLifecycle.zeroUseActiveCount;
  return [
    { label: "active", count: activeCount },
    { label: "used", count: Math.max(0, activeCount - zeroUseCount) },
    { label: "zero-use", count: zeroUseCount },
    { label: "stale", count: report.knowledgeLifecycle.staleByDecayCount },
    { label: "deprecated", count: report.mcp.staleKnowledgeCount },
  ];
}

export function OverviewCharts({
  dashboard,
  doctorReport,
}: {
  dashboard: OverviewDashboard;
  doctorReport?: DoctorReport | null;
}) {
  const knowledgeData = dashboard.charts.knowledgeByStatusType.map((item) => ({
    ...item,
    statusLabel: knowledgeStatusLabel[item.status],
  }));
  const queueData = dashboard.charts.distillationQueue.map((item) => ({
    ...item,
    targetLabel: distillationLabel[item.targetKind],
  }));
  const llmData = dashboard.llmUsage.daily.map((item) => ({
    ...item,
    localTokens: item.localPromptTokens + item.localCompletionTokens,
    cloudTokens: item.cloudPromptTokens + item.cloudCompletionTokens,
    totalTokens: item.totalTokens,
  }));
  const compileMix = compileMixData(doctorReport);
  const compileLatency = compileLatencyData(doctorReport);
  const knowledgeUsageLifecycle = knowledgeUsageLifecycleData(doctorReport);
  const avgLatencyMs =
    typeof doctorReport?.runs.durationMsAvg === "number" &&
    Number.isFinite(doctorReport.runs.durationMsAvg)
      ? Math.round(doctorReport.runs.durationMsAvg)
      : null;
  const avgLatencyBucket = averageLatencyBucketLabel(avgLatencyMs);

  return (
    <section className="overview-chart-grid">
      <AdminChartCard title="Daily LLM Tokens (14d)">
        <div className="overview-chart-frame">
          <LineChart responsive style={{ width: "100%", height: "100%" }} data={llmData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" minTickGap={24} />
            <YAxis tickFormatter={formatCompactNumber} />
            <Tooltip
              formatter={(value, name, item) => {
                const dataKey = String(item.dataKey ?? name);
                if (dataKey === "localTokens" || dataKey === "cloudTokens") {
                  const payload = item.payload as (typeof llmData)[number] | undefined;
                  const promptTokens =
                    dataKey === "localTokens"
                      ? payload?.localPromptTokens
                      : payload?.cloudPromptTokens;
                  const completionTokens =
                    dataKey === "localTokens"
                      ? payload?.localCompletionTokens
                      : payload?.cloudCompletionTokens;
                  const reasoningTokens =
                    dataKey === "localTokens"
                      ? payload?.localReasoningTokens
                      : payload?.cloudReasoningTokens;
                  return [
                    `in ${formatCompactNumber(promptTokens)} / out ${formatCompactNumber(completionTokens)} / reasoning ${formatCompactNumber(reasoningTokens)}`,
                    llmTooltipLabel[dataKey],
                  ];
                }
                return [formatCompactNumber(value), llmTooltipLabel[dataKey] ?? dataKey];
              }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="totalTokens"
              name="Total tokens"
              stroke="#0f766e"
              dot={false}
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="localTokens"
              name="Local tokens"
              stroke="#7c3aed"
              dot={false}
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="cloudTokens"
              name="Cloud tokens"
              stroke="#2563eb"
              dot={false}
              strokeWidth={2}
            />
          </LineChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Cloud LLM Tokens & Cost (14d)">
        <div className="overview-chart-frame">
          <ComposedChart responsive style={{ width: "100%", height: "100%" }} data={llmData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" minTickGap={24} />
            <YAxis yAxisId="tokens" tickFormatter={formatCompactNumber} />
            <YAxis yAxisId="cost" orientation="right" tickFormatter={formatJpy} />
            <Tooltip
              formatter={(value, name, item) => {
                const dataKey = String(item.dataKey ?? name);
                if (dataKey === "costJpy") return [formatJpy(value), llmTooltipLabel[dataKey]];
                const payload = item.payload as (typeof llmData)[number] | undefined;
                const detail =
                  dataKey === "cloudTokens" && payload
                    ? `in ${payload.cloudPromptTokens} / out ${payload.cloudCompletionTokens} / reasoning ${payload.cloudReasoningTokens}`
                    : formatCompactNumber(value);
                return [detail, llmTooltipLabel[dataKey] ?? dataKey];
              }}
            />
            <Legend />
            <Bar
              yAxisId="tokens"
              dataKey="cloudTokens"
              name="Cloud tokens"
              stackId="tokens"
              fill="#2563eb"
            />
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="costJpy"
              name="Cloud cost"
              stroke="#f97316"
              dot={false}
              strokeWidth={2}
            />
          </ComposedChart>
        </div>
      </AdminChartCard>

      {compileMix.length > 0 ? (
        <AdminChartCard title="Compile Quality Mix">
          <div className="overview-chart-frame">
            <BarChart responsive style={{ width: "100%", height: "100%" }} data={compileMix}>
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
              <Bar dataKey="count" name="runs">
                {compileMix.map((item) => (
                  <Cell key={item.label} fill={item.color} />
                ))}
              </Bar>
            </BarChart>
          </div>
        </AdminChartCard>
      ) : null}

      {compileLatency.length > 0 ? (
        <AdminChartCard title="Compile Latency">
          <div className="overview-chart-frame">
            <BarChart responsive style={{ width: "100%", height: "100%" }} data={compileLatency}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" minTickGap={12} />
              <YAxis allowDecimals={false} />
              <Tooltip
                formatter={(value) => [`${value}`, "runs"]}
                labelFormatter={(label) => `duration ${label}`}
              />
              <Legend />
              {avgLatencyMs !== null && avgLatencyBucket !== null ? (
                <ReferenceLine
                  x={avgLatencyBucket}
                  stroke="#334155"
                  strokeDasharray="5 5"
                  label={{
                    value: `avg ${formatDurationSeconds(avgLatencyMs)}`,
                    position: "insideTopRight",
                    fill: "#334155",
                    fontSize: 12,
                  }}
                />
              ) : null}
              <Bar dataKey="count" name="runs" fill="#0f766e" />
            </BarChart>
          </div>
        </AdminChartCard>
      ) : null}

      {knowledgeUsageLifecycle.length > 0 ? (
        <AdminChartCard title="Knowledge Usage Lifecycle">
          <div className="overview-chart-frame">
            <BarChart
              responsive
              style={{ width: "100%", height: "100%" }}
              data={knowledgeUsageLifecycle}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="count" fill="#475569" />
            </BarChart>
          </div>
        </AdminChartCard>
      ) : null}

      <AdminChartCard title="Knowledge Status by Type">
        <div className="overview-chart-frame">
          <BarChart responsive style={{ width: "100%", height: "100%" }} data={knowledgeData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="statusLabel" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="rule" stackId="knowledge" fill="#2563eb" />
            <Bar dataKey="procedure" stackId="knowledge" fill="#06b6d4" />
          </BarChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Dynamic Score Distribution">
        <div className="overview-chart-frame">
          <BarChart
            responsive
            style={{ width: "100%", height: "100%" }}
            data={dashboard.charts.dynamicScoreBuckets}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="count" fill="#0f766e" />
          </BarChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Compile Health (14d)">
        <div className="overview-chart-frame">
          <ComposedChart
            responsive
            style={{ width: "100%", height: "100%" }}
            data={dashboard.charts.compileRunsByDay}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" minTickGap={24} />
            <YAxis yAxisId="runs" allowDecimals={false} />
            <YAxis yAxisId="duration" orientation="right" />
            <Tooltip
              formatter={(value, name) =>
                name === "avgDurationMs" ? roundDuration(parseNullableDuration(value)) : value
              }
            />
            <Legend />
            <Bar yAxisId="runs" dataKey="ok" stackId="runs" fill="#16a34a" />
            <Bar yAxisId="runs" dataKey="degraded" stackId="runs" fill="#f59e0b" />
            <Bar yAxisId="runs" dataKey="failed" stackId="runs" fill="#dc2626" />
            <Line
              yAxisId="duration"
              type="monotone"
              dataKey="avgDurationMs"
              stroke="#334155"
              dot={false}
              strokeWidth={2}
            />
          </ComposedChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Vibe Ingestion (14d)">
        <div className="overview-chart-frame">
          <LineChart
            responsive
            style={{ width: "100%", height: "100%" }}
            data={dashboard.charts.vibeRecordsByDay}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" minTickGap={24} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="records" stroke="#0891b2" strokeWidth={2} />
          </LineChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Source Coverage">
        <div className="overview-chart-frame">
          <BarChart
            responsive
            style={{ width: "100%", height: "100%" }}
            data={dashboard.charts.sourceCoverage}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="count" fill="#475569" />
          </BarChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Community Source Coverage">
        <div className="overview-chart-frame">
          <BarChart
            responsive
            style={{ width: "100%", height: "100%" }}
            data={dashboard.charts.communitySourceCoverage}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="count" fill="#0f766e" />
          </BarChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Distillation Queue">
        <div className="overview-chart-frame">
          <BarChart responsive style={{ width: "100%", height: "100%" }} data={queueData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="targetLabel" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="pending" stackId="queue" fill="#2563eb" />
            <Bar dataKey="running" stackId="queue" fill="#0891b2" />
            <Bar dataKey="paused" stackId="queue" fill="#64748b" />
            <Bar dataKey="completed" stackId="queue" fill="#16a34a" />
            <Bar dataKey="failed" stackId="queue" fill="#dc2626" />
          </BarChart>
        </div>
      </AdminChartCard>
    </section>
  );
}
