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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { OverviewDashboard } from "../repositories/admin.repository";

const knowledgeStatusLabel: Record<"active" | "draft" | "deprecated", string> = {
  active: "active",
  draft: "draft",
  deprecated: "deprecated",
};

const distillationLabel: Record<"wiki_file" | "vibe_memory", string> = {
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

export function OverviewCharts({ dashboard }: { dashboard: OverviewDashboard }) {
  const knowledgeData = dashboard.charts.knowledgeByStatusType.map((item) => ({
    ...item,
    statusLabel: knowledgeStatusLabel[item.status],
  }));
  const queueData = dashboard.charts.distillationQueue.map((item) => ({
    ...item,
    targetLabel: distillationLabel[item.targetKind],
  }));

  return (
    <section className="overview-chart-grid">
      <Card className="overview-chart-card">
        <CardHeader>
          <CardTitle>Knowledge Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card className="overview-chart-card">
        <CardHeader>
          <CardTitle>Dynamic Score Distribution</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card className="overview-chart-card">
        <CardHeader>
          <CardTitle>Compile Health (14d)</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card className="overview-chart-card">
        <CardHeader>
          <CardTitle>Vibe Ingestion (14d)</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card className="overview-chart-card">
        <CardHeader>
          <CardTitle>Source Coverage</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card className="overview-chart-card">
        <CardHeader>
          <CardTitle>Distillation Queue</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    </section>
  );
}
