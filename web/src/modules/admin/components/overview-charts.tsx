import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { OverviewDashboard } from "../repositories/admin.repository";
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

export function OverviewCharts({ dashboard }: { dashboard: OverviewDashboard }) {
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

      <AdminChartCard title="Knowledge Lifecycle">
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
