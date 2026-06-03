import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  DoctorReport,
  OverviewKnowledgeAssetsDomain,
  OverviewLlmResourcesDomain,
  OverviewSystemQualityDomain,
} from "../repositories/admin.repository";
import { AdminChartCard } from "./admin-chart-card";

type CompileRunHealth = OverviewSystemQualityDomain["compileRunHealth"];

const knowledgeStatusLabel: Record<"active" | "draft" | "deprecated", string> = {
  active: "active",
  draft: "draft",
  deprecated: "deprecated",
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

function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value / 1000).toFixed(1)}s`;
}

function compileLatencyData(runHealth: CompileRunHealth) {
  const samples = runHealth.durationSamples ?? [];
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

export function KnowledgeCharts({
  dashboard,
  doctorReport,
}: {
  dashboard: OverviewKnowledgeAssetsDomain;
  doctorReport?: DoctorReport | null;
}) {
  const knowledgeData = dashboard.charts.knowledgeByStatusType.map((item) => ({
    ...item,
    statusLabel: knowledgeStatusLabel[item.status],
  }));
  const knowledgeUsageLifecycle = knowledgeUsageLifecycleData(doctorReport);

  return (
    <div className="domain-charts-grid">
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
              <Bar dataKey="count" fill="#10b981" name="items" />
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
            <Bar dataKey="rule" stackId="knowledge" name="rule" fill="#059669" />
            <Bar dataKey="procedure" stackId="knowledge" name="procedure" fill="#34d399" />
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
            <Bar dataKey="count" fill="#047857" name="candidates" />
          </BarChart>
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
            <Line
              type="monotone"
              dataKey="records"
              name="vibe records"
              stroke="#10b981"
              strokeWidth={2}
            />
          </LineChart>
        </div>
      </AdminChartCard>

      <AdminChartCard title="Knowledge Source & Community Coverage">
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
            <Bar dataKey="count" name="communities" fill="#10b981" />
          </BarChart>
        </div>
      </AdminChartCard>
    </div>
  );
}

export function SystemHealthCharts({
  dashboard,
}: {
  dashboard: OverviewSystemQualityDomain;
}) {
  const compileLatency = compileLatencyData(dashboard.compileRunHealth);
  const compileEvalData = dashboard.compileEvalStats.metrics.map((item) => ({
    ...item,
    average: item.average ?? 0,
    displayAverage: item.average === null ? "-" : `${item.average.toFixed(1)}`,
    axisLabel: `${item.label}: ${item.average === null ? "-" : item.average.toFixed(1)}`,
  }));
  const avgLatencyMs =
    typeof dashboard.compileRunHealth.durationMsAvg === "number" &&
    Number.isFinite(dashboard.compileRunHealth.durationMsAvg)
      ? Math.round(dashboard.compileRunHealth.durationMsAvg)
      : null;
  const avgLatencyBucket = averageLatencyBucketLabel(avgLatencyMs);

  return (
    <div className="domain-charts-grid">
      {dashboard.compileEvalStats.evaluationCount > 0 ? (
        <AdminChartCard
          title={`Compile Eval Metrics (${dashboard.compileEvalStats.windowLabel}, n=${dashboard.compileEvalStats.evaluationCount})`}
        >
          <div className="overview-chart-frame">
            <RadarChart responsive style={{ width: "100%", height: "100%" }} data={compileEvalData}>
              <PolarGrid />
              <PolarAngleAxis dataKey="axisLabel" />
              <PolarRadiusAxis angle={90} domain={[0, 100]} tick={false} tickCount={6} />
              <Tooltip
                formatter={(value, _name, item) => [item.payload.displayAverage, "avg score"]}
              />
              <Legend />
              <Radar
                dataKey="average"
                name="eval avg"
                stroke="#06b6d4"
                fill="#06b6d4"
                fillOpacity={0.22}
              />
            </RadarChart>
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
              <Bar dataKey="count" name="runs" fill="#06b6d4" />
            </BarChart>
          </div>
        </AdminChartCard>
      ) : null}

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
            <Bar yAxisId="runs" dataKey="ok" stackId="runs" name="ok" fill="#10b981" />
            <Bar yAxisId="runs" dataKey="degraded" stackId="runs" name="degraded" fill="#f59e0b" />
            <Bar yAxisId="runs" dataKey="failed" stackId="runs" name="failed" fill="#ef4444" />
            <Line
              yAxisId="duration"
              type="monotone"
              dataKey="avgDurationMs"
              name="avg duration"
              stroke="#06b6d4"
              dot={false}
              strokeWidth={2}
            />
          </ComposedChart>
        </div>
      </AdminChartCard>
    </div>
  );
}

export function LlmCharts({
  dashboard,
}: {
  dashboard: OverviewLlmResourcesDomain;
}) {
  const llmData = dashboard.llmUsage.daily.map((item) => ({
    ...item,
    localTokens: item.localPromptTokens + item.localCompletionTokens,
    cloudTokens: item.cloudPromptTokens + item.cloudCompletionTokens,
    totalTokens: item.totalTokens,
  }));

  return (
    <div className="domain-charts-grid">
      <AdminChartCard title="Daily LLM Tokens & Cloud Cost (14d)">
        <div className="overview-chart-frame">
          <ComposedChart responsive style={{ width: "100%", height: "100%" }} data={llmData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" minTickGap={24} />
            <YAxis yAxisId="tokens" tickFormatter={formatCompactNumber} />
            <YAxis yAxisId="cost" orientation="right" tickFormatter={formatJpy} />
            <Tooltip
              formatter={(value, name, item) => {
                const dataKey = String(item.dataKey ?? name);
                if (dataKey === "costJpy") return [formatJpy(value), "Cloud Cost"];
                const payload = item.payload as (typeof llmData)[number] | undefined;
                const detail =
                  (dataKey === "cloudTokens" || dataKey === "localTokens") && payload
                    ? dataKey === "cloudTokens"
                      ? `in ${formatCompactNumber(payload.cloudPromptTokens)} / out ${formatCompactNumber(payload.cloudCompletionTokens)} / reasoning ${formatCompactNumber(payload.cloudReasoningTokens)}`
                      : `in ${formatCompactNumber(payload.localPromptTokens)} / out ${formatCompactNumber(payload.localCompletionTokens)}`
                    : formatCompactNumber(value);
                const labelMap: Record<string, string> = {
                  localTokens: "Local Tokens",
                  cloudTokens: "Cloud Tokens",
                  totalTokens: "Total Tokens",
                };
                return [detail, labelMap[dataKey] ?? dataKey];
              }}
            />
            <Legend />
            <Bar
              yAxisId="tokens"
              dataKey="localTokens"
              name="Local Tokens"
              stackId="tokens"
              fill="#a78bfa"
            />
            <Bar
              yAxisId="tokens"
              dataKey="cloudTokens"
              name="Cloud Tokens"
              stackId="tokens"
              fill="#6d28d9"
            />
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="costJpy"
              name="Cloud Cost"
              stroke="#f43f5e"
              dot={false}
              strokeWidth={2}
            />
          </ComposedChart>
        </div>
      </AdminChartCard>
    </div>
  );
}
