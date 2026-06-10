import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate as tzFormatDate, useTimezone } from "@/lib/timezone";
import { Settings2 } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";
import {
  useCreateContextDecisionMutation,
  useContextDecisionDetail,
  useContextDecisionFeedbackMutation,
  useContextDecisionRuns,
} from "../hooks/context-decision.hooks";
import type {
  ContextDecisionEvidence,
  ContextDecisionKnowledgeAssessment,
  ContextDecisionKnowledgePrior,
  ContextDecisionMlSignal,
  ContextDecisionRequest,
  ContextDecisionResult,
  ContextDecisionRunDetail,
  ContextDecisionRunSummary,
} from "../repositories/context-decision.repository";
import {
  ContextDecisionRunSidebar,
  type DecisionFeedbackFilter,
  DecisionStatusBadge,
  type DecisionStatusFilter,
  DecisionBadge,
} from "./context-decision.run-sidebar";

type PageMode = "new" | "detail";

type DecisionFormState = {
  decisionPoint: string;
  technologiesCsv: string;
  changeTypesCsv: string;
  domainsCsv: string;
};

const emptyDecisionForm: DecisionFormState = {
  decisionPoint: "",
  technologiesCsv: "",
  changeTypesCsv: "",
  domainsCsv: "",
};

const exampleDecisionForm: DecisionFormState = {
  decisionPoint: "Should I continue implementing the UI form now or stop and ask for confirmation?",
  technologiesCsv: "typescript, react",
  changeTypesCsv: "frontend, ui-fix",
  domainsCsv: "context-decision, context-compiler, web-ui",
};

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toDecisionRequest(state: DecisionFormState): ContextDecisionRequest {
  return {
    decisionPoint: state.decisionPoint.trim(),
    retrievalHints: {
      technologies: parseCsv(state.technologiesCsv),
      changeTypes: parseCsv(state.changeTypesCsv),
      domains: parseCsv(state.domainsCsv),
    },
    metadata: { source: "ui" },
  };
}

function groupByRole(items: ContextDecisionEvidence[]): Record<string, ContextDecisionEvidence[]> {
  return items.reduce<Record<string, ContextDecisionEvidence[]>>((groups, item) => {
    groups[item.role] = [...(groups[item.role] ?? []), item];
    return groups;
  }, {});
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div className="compile-metric">
      <span>{label}</span>
      <strong>{value ?? "-"}</strong>
    </div>
  );
}

function HintMetric({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="compile-pack-item" style={{ padding: "10px 12px" }}>
      <div className="compile-pack-item-header">
        <strong>{label}</strong>
      </div>
      {values.length > 0 ? (
        <div className="compile-code-badge-list">
          {values.map((value) => (
            <code key={`${label}:${value}`}>{value}</code>
          ))}
        </div>
      ) : (
        <p className="compile-state-text">-</p>
      )}
    </div>
  );
}

function splitEvidenceSummary(summary: string): {
  title: string;
  body: string;
} {
  const separator = summary.indexOf(": ");
  if (separator <= 0) return { title: "Knowledge evidence", body: summary };
  return {
    title: summary.slice(0, separator).trim(),
    body: summary.slice(separator + 2).trim(),
  };
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function evidenceUsageLabel(role: ContextDecisionEvidence["role"]): string {
  if (role === "rejected_alternative") return "not used";
  if (role === "missing_counter_evidence") return "not found";
  return "used";
}

function traceNumber(trace: Record<string, unknown>, key: string): number {
  const value = trace[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function traceString(trace: Record<string, unknown>, key: string): string | null {
  const value = trace[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function asMlSignal(value: unknown): ContextDecisionMlSignal | null {
  if (!isRecord(value)) return null;
  if (value.model !== "ml-random-forest") return null;
  if (typeof value.status !== "string") return null;
  const features = isRecord(value.features) ? value.features : {};
  const classDistribution = isRecord(value.classDistribution) ? value.classDistribution : {};
  return {
    status: value.status as ContextDecisionMlSignal["status"],
    model: "ml-random-forest",
    modelVersion: typeof value.modelVersion === "string" ? value.modelVersion : "-",
    featureVersion:
      value.featureVersion === "context-decision-ml-features-v1"
        ? "context-decision-ml-features-v1"
        : "context-decision-ml-features-v1",
    predictedDecision:
      typeof value.predictedDecision === "string"
        ? (value.predictedDecision as ContextDecisionMlSignal["predictedDecision"])
        : undefined,
    confidence: typeof value.confidence === "number" ? value.confidence : undefined,
    trainingSampleCount:
      typeof value.trainingSampleCount === "number" ? value.trainingSampleCount : 0,
    classDistribution: Object.fromEntries(
      Object.entries(classDistribution).map(([key, raw]) => [key, Number(raw) || 0]),
    ),
    features: Object.fromEntries(
      Object.entries(features).map(([key, raw]) => [key, Number(raw) || 0]),
    ),
    reason: typeof value.reason === "string" ? value.reason : "-",
  };
}

function asKnowledgeAssessment(value: unknown): ContextDecisionKnowledgeAssessment | null {
  if (!isRecord(value)) return null;
  if (typeof value.status !== "string" || typeof value.recommendedDirection !== "string") {
    return null;
  }
  const retrievalMethods = Array.isArray(value.retrievalMethods)
    ? value.retrievalMethods.filter(
        (item): item is "vector" | "keyword" | "hybrid" =>
          item === "vector" || item === "keyword" || item === "hybrid",
      )
    : [];
  const numberValue = (key: keyof ContextDecisionKnowledgeAssessment) => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 0;
  };
  const meaningfulMetrics = Array.isArray(value.meaningfulMetrics)
    ? value.meaningfulMetrics
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          key: typeof item.key === "string" ? item.key : "knowledgeCoverage",
          label: typeof item.label === "string" ? item.label : "Metric",
          value:
            typeof item.value === "number" && Number.isFinite(item.value)
              ? Math.round(item.value)
              : 0,
        }))
        .filter(
          (
            item,
          ): item is NonNullable<ContextDecisionKnowledgeAssessment["meaningfulMetrics"]>[number] =>
            [
              "knowledgeCoverage",
              "supportStrength",
              "counterEvidenceStrength",
              "riskStrength",
              "preferenceAlignment",
              "applicabilityScore",
              "consensusScore",
              "conflictScore",
              "outOfDistributionScore",
            ].includes(item.key),
        )
    : undefined;
  return {
    status: value.status as ContextDecisionKnowledgeAssessment["status"],
    recommendedDirection:
      value.recommendedDirection as ContextDecisionKnowledgeAssessment["recommendedDirection"],
    knowledgeCoverage: numberValue("knowledgeCoverage"),
    supportStrength: numberValue("supportStrength"),
    counterEvidenceStrength: numberValue("counterEvidenceStrength"),
    riskStrength: numberValue("riskStrength"),
    preferenceAlignment: numberValue("preferenceAlignment"),
    applicabilityScore: numberValue("applicabilityScore"),
    consensusScore: numberValue("consensusScore"),
    conflictScore: numberValue("conflictScore"),
    sourceQualityScore: numberValue("sourceQualityScore"),
    outOfDistributionScore: numberValue("outOfDistributionScore"),
    retrievalMethods,
    reason: typeof value.reason === "string" ? value.reason : "-",
    meaningfulMetrics,
  };
}

function asKnowledgePrior(value: unknown): ContextDecisionKnowledgePrior | null {
  if (!isRecord(value)) return null;
  if (value.source !== "retrieval_prior_v1" && value.source !== "corpus_prior_v1") return null;
  if (value.referenceOnly !== true || value.notUsedForScoring !== true) return null;
  const toStringArray = (raw: unknown) =>
    Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  return {
    status:
      value.status === "available" || value.status === "limited" || value.status === "unavailable"
        ? value.status
        : "unavailable",
    source: value.source,
    referenceOnly: true,
    notUsedForScoring: true,
    evidenceCount: typeof value.evidenceCount === "number" ? value.evidenceCount : 0,
    candidateCount: typeof value.candidateCount === "number" ? value.candidateCount : 0,
    summary: typeof value.summary === "string" ? value.summary : "-",
    signals: toStringArray(value.signals),
    cautions: toStringArray(value.cautions),
  };
}

function mlConfidenceLabel(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function KnowledgePriorPanel({
  trace,
  traceKey,
  title,
  missingText,
}: {
  trace: Record<string, unknown>;
  traceKey: "knowledgePrior" | "corpusKnowledgePrior";
  title: string;
  missingText: string;
}) {
  const prior = asKnowledgePrior(trace[traceKey]);
  const isCorpusPrior = prior?.source === "corpus_prior_v1";
  if (!prior) {
    return (
      <article className="compile-pack-item">
        <div className="compile-pack-item-header">
          <strong>{title}</strong>
          <Badge variant="outline">not recorded</Badge>
        </div>
        <p className="compile-state-text">{missingText}</p>
      </article>
    );
  }
  return (
    <article className="compile-pack-item">
      <div className="compile-pack-item-header">
        <strong>{title}</strong>
        <div className="compile-pack-item-meta">
          <Badge variant={prior.status === "available" ? "secondary" : "outline"}>
            {prior.status}
          </Badge>
          <Badge variant="outline">reference only</Badge>
        </div>
      </div>
      {!isCorpusPrior ? (
        <div className="compile-metric-grid" style={{ marginTop: 8 }}>
          <Metric label="Evidence" value={prior.evidenceCount} />
          <Metric label="Candidates" value={prior.candidateCount} />
        </div>
      ) : null}
      {[...prior.signals, ...prior.cautions].length > 0 ? (
        <div className="compile-code-badge-list" style={{ marginTop: 10 }}>
          {[...prior.signals, ...prior.cautions].slice(0, 6).map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function KnowledgeAssessmentPanel({ trace }: { trace: Record<string, unknown> }) {
  const assessment = asKnowledgeAssessment(trace.knowledgeAssessment);
  if (!assessment) {
    return (
      <article className="compile-pack-item">
        <div className="compile-pack-item-header">
          <strong>Knowledge Assessment</strong>
          <Badge variant="outline">not recorded</Badge>
        </div>
        <p className="compile-state-text">
          This older decision does not include Knowledge Assessment trace data.
        </p>
      </article>
    );
  }
  const metrics = assessment.meaningfulMetrics ?? [
    { key: "knowledgeCoverage", label: "Coverage", value: assessment.knowledgeCoverage },
    { key: "supportStrength", label: "Support", value: assessment.supportStrength },
    {
      key: "counterEvidenceStrength",
      label: "Counter",
      value: assessment.counterEvidenceStrength,
    },
    { key: "consensusScore", label: "Consensus", value: assessment.consensusScore },
  ];

  return (
    <article className="compile-pack-item">
      <div className="compile-pack-item-header">
        <strong>Knowledge Assessment</strong>
        <div className="compile-pack-item-meta">
          <Badge variant={assessment.status === "evaluable" ? "secondary" : "outline"}>
            {assessment.status}
          </Badge>
          <Badge variant="outline">{assessment.recommendedDirection}</Badge>
        </div>
      </div>
      <div className="compile-metric-grid" style={{ marginTop: 8 }}>
        {metrics.map((item) => (
          <Metric key={item.key} label={item.label} value={`${item.value}%`} />
        ))}
      </div>
      <div className="compile-code-badge-list" style={{ marginTop: 10 }}>
        {assessment.retrievalMethods.length > 0 ? (
          assessment.retrievalMethods.map((method) => <code key={method}>{method}</code>)
        ) : (
          <code>keyword</code>
        )}
      </div>
    </article>
  );
}

function OutcomePredictorPanel({ trace }: { trace: Record<string, unknown> }) {
  const mlSignal = asMlSignal(trace.outcomePredictor ?? trace.mlSignal);
  const judgmentStatus = traceString(trace, "llmJudgmentStatus");
  if (!mlSignal) {
    return (
      <article className="compile-pack-item">
        <div className="compile-pack-item-header">
          <strong>Outcome Predictor</strong>
          <Badge variant="outline">not recorded</Badge>
        </div>
        <p className="compile-state-text">
          No outcome-history predictor result is stored on this decision trace.
        </p>
      </article>
    );
  }

  const distributionEntries = Object.entries(mlSignal.classDistribution);
  const predictorReady = mlSignal.status === "ready";
  const featureSnapshot = [
    ["support hits", mlSignal.features.supportHitCount],
    ["selected support", mlSignal.features.selectedSupportCount],
    ["deterministic confidence", mlSignal.features.deterministicConfidence],
    ["related bad signals", mlSignal.features.relatedBadSignalCount],
  ];

  return (
    <article className="compile-pack-item">
      <div className="compile-pack-item-header">
        <strong>Outcome Predictor</strong>
        <div className="compile-pack-item-meta">
          <Badge variant={mlSignal.status === "ready" ? "secondary" : "outline"}>
            {mlSignal.status}
          </Badge>
          {judgmentStatus ? <Badge variant="outline">LLM {judgmentStatus}</Badge> : null}
        </div>
      </div>

      {predictorReady ? (
        <>
          <div className="compile-metric-grid" style={{ marginTop: 8 }}>
            <Metric label="Predicted" value={mlSignal.predictedDecision ?? "-"} />
            <Metric label="Predictor Confidence" value={mlConfidenceLabel(mlSignal.confidence)} />
            <Metric label="Training Rows" value={mlSignal.trainingSampleCount} />
          </div>

          {mlSignal.reason ? (
            <p className="compile-state-text" style={{ marginTop: 10 }}>
              {mlSignal.reason}
            </p>
          ) : null}
        </>
      ) : null}

      {predictorReady && distributionEntries.length > 0 ? (
        <div className="compile-code-badge-list" style={{ marginTop: 10 }}>
          {distributionEntries.map(([decision, count]) => (
            <code key={decision}>
              {decision}: {count}
            </code>
          ))}
        </div>
      ) : null}

      <div className="compile-code-badge-list" style={{ marginTop: 10 }}>
        {featureSnapshot.map(([label, value]) => (
          <code key={label}>
            {label}: {typeof value === "number" ? Math.round(value) : 0}
          </code>
        ))}
      </div>
    </article>
  );
}

function DecisionScoreRadar({ trace }: { trace: Record<string, unknown> }) {
  const data = [
    {
      subject: `Support ${traceNumber(trace, "supportScore")}`,
      value: traceNumber(trace, "supportScore"),
    },
    {
      subject: `Counter ${traceNumber(trace, "counterScore")}`,
      value: traceNumber(trace, "counterScore"),
    },
    {
      subject: `Preference ${traceNumber(trace, "preferenceScore")}`,
      value: traceNumber(trace, "preferenceScore"),
    },
    {
      subject: `Coverage ${traceNumber(trace, "coverageScore")}`,
      value: traceNumber(trace, "coverageScore"),
    },
    {
      subject: `Verification ${traceNumber(trace, "verificationScore")}`,
      value: traceNumber(trace, "verificationScore"),
    },
    {
      subject: `History ${traceNumber(trace, "historicalFeedbackScore")}`,
      value: traceNumber(trace, "historicalFeedbackScore"),
    },
  ];

  return (
    <div
      style={{
        width: "100%",
        height: 260,
        padding: 8,
        border: "1px solid rgba(0,0,0,0.06)",
        borderRadius: 8,
        background: "rgba(0,0,0,0.01)",
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} margin={{ top: 16, right: 42, bottom: 16, left: 42 }}>
          <PolarGrid stroke="rgba(0,0,0,0.08)" gridType="polygon" />
          <PolarAngleAxis
            dataKey="subject"
            tick={{ fill: "#4b5563", fontSize: 11, fontWeight: 600 }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tick={{ fill: "#6b7280", fontSize: 10 }}
            axisLine={false}
          />
          <Radar
            name="Decision score"
            dataKey="value"
            stroke="#2563eb"
            fill="#2563eb"
            fillOpacity={0.16}
            strokeWidth={2}
            dot={{ r: 3, fill: "#60a5fa", stroke: "#fff", strokeWidth: 1 }}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function DecisionRequestPane({
  pending,
  error,
  onSubmit,
}: {
  pending: boolean;
  error: unknown;
  onSubmit: (input: ContextDecisionRequest) => Promise<ContextDecisionResult>;
}) {
  const [form, setForm] = useState<DecisionFormState>(emptyDecisionForm);
  const [formError, setFormError] = useState<string | null>(null);

  const update = <K extends keyof DecisionFormState>(key: K, value: DecisionFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = toDecisionRequest(form);
    if (!input.decisionPoint) {
      setFormError("Decision point is required.");
      return;
    }
    setFormError(null);
    await onSubmit(input);
  };

  return (
    <Card className="compile-main-card compile-prompt-card">
      <CardContent>
        <form className="compile-form" onSubmit={submit}>
          <div className="compile-prompt-header">
            <div>
              <Badge variant="secondary" className="type-badge">
                context decision
              </Badge>
              <h2>Decision Request</h2>
            </div>
            <span>UI source</span>
          </div>

          <div className="compile-goal-editor">
            <Label htmlFor="decisionPoint">Decision Point</Label>
            <Textarea
              id="decisionPoint"
              rows={4}
              value={form.decisionPoint}
              onChange={(event) => update("decisionPoint", event.currentTarget.value)}
              placeholder="Describe the concrete decision that should be made"
            />
          </div>

          <section className="compile-options-panel" aria-label="Retrieval hints">
            <div className="compile-options-title">
              <Settings2 size={16} />
              <h3>Retrieval Hints</h3>
            </div>
            <div className="compile-form-grid">
              <div className="grid gap-2">
                <Label htmlFor="technologiesCsv">Technologies</Label>
                <Input
                  id="technologiesCsv"
                  value={form.technologiesCsv}
                  onChange={(event) => update("technologiesCsv", event.currentTarget.value)}
                  placeholder="typescript, react"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="changeTypesCsv">Change Types</Label>
                <Input
                  id="changeTypesCsv"
                  value={form.changeTypesCsv}
                  onChange={(event) => update("changeTypesCsv", event.currentTarget.value)}
                  placeholder="frontend, ui-fix"
                />
              </div>
            </div>
            <div className="compile-form-grid">
              <div className="grid gap-2">
                <Label htmlFor="domainsCsv">Domains</Label>
                <Input
                  id="domainsCsv"
                  value={form.domainsCsv}
                  onChange={(event) => update("domainsCsv", event.currentTarget.value)}
                  placeholder="context-decision, context-compiler"
                />
              </div>
            </div>
          </section>

          <div className="compile-form-actions">
            <Button type="submit" disabled={pending}>
              {pending ? "Deciding..." : "Ask Decision"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setForm(exampleDecisionForm);
                setFormError(null);
              }}
            >
              Example
            </Button>
            {formError ? <p className="text-destructive text-sm">{formError}</p> : null}
            {error ? <p className="text-destructive text-sm">{String(error)}</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function DecisionDetailPane({
  detail,
  isLoading,
  error,
  feedbackPending,
  onFeedback,
}: {
  detail: ContextDecisionRunDetail | undefined;
  isLoading: boolean;
  error: unknown;
  feedbackPending: boolean;
  onFeedback: (decisionId: string, value: "good" | "bad") => void;
}) {
  const tz = useTimezone();
  const evidenceByRole = useMemo(() => groupByRole(detail?.evidence ?? []), [detail?.evidence]);
  const selectedEvidence = (detail?.evidence ?? []).filter(
    (item) => item.role === "selected_support" || item.role === "user_preference",
  );
  const supportCoverage = (detail?.coverage ?? []).filter((trace) => trace.queryRole === "support");
  const totalHits = (detail?.coverage ?? []).reduce((sum, trace) => sum + trace.hitCount, 0);

  if (isLoading) {
    return (
      <Card className="compile-main-card">
        <CardContent>
          <p className="compile-state-text">Loading detail...</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="compile-main-card">
        <CardContent>
          <p className="compile-state-text destructive">{String(error)}</p>
        </CardContent>
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card className="compile-main-card">
        <CardContent>
          <div className="compile-empty-state">
            <strong>No decision selected</strong>
            <p>Select a context decision run from the sidebar.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="compile-main-card">
      <CardContent>
        <div className="compile-detail-header">
          <div>
            <h2>{detail.run.decisionPoint}</h2>
            <div className="compile-run-meta">
              <DecisionStatusBadge status={detail.run.status} />
              <DecisionBadge decision={detail.run.decision} />
              <span>{detail.run.confidence}% confidence</span>
              <span>{detail.run.humanFeedback ?? "no feedback"}</span>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "11px",
                  color: "#6b7280",
                }}
              >
                id: {detail.run.id}
              </span>
            </div>
          </div>
          <time>{tzFormatDate(detail.run.createdAt, tz)}</time>
        </div>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Decision Answer</h3>
            <Badge variant="outline">LLM</Badge>
          </div>
          <div className="compile-pack-item">
            <p>{detail.run.agentMessage}</p>
          </div>
        </section>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Decision Summary</h3>
            <Badge variant="outline">{detail.run.status}</Badge>
          </div>
          <div className="compile-metric-grid">
            <Metric label="Decision" value={detail.run.decision} />
            <Metric label="Confidence" value={`${detail.run.confidence}%`} />
            <Metric label="Evidence" value={detail.evidence.length} />
            <Metric label="Coverage Hits" value={totalHits} />
          </div>
          <div className="compile-pack-item">
            <div className="compile-pack-item-header">
              <strong>Mandate</strong>
            </div>
            <p>{detail.run.mandate}</p>
          </div>
        </section>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Ranking Trace</h3>
            <Badge variant="outline">{selectedEvidence.length} used</Badge>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 12,
              alignItems: "start",
            }}
          >
            <DecisionScoreRadar trace={detail.run.confidenceTrace} />
            <div className="compile-pack-items">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 8,
                }}
              >
                <HintMetric label="Technologies" values={detail.run.retrievalHints.technologies} />
                <HintMetric label="Change Types" values={detail.run.retrievalHints.changeTypes} />
                <HintMetric label="Domains" values={detail.run.retrievalHints.domains} />
                <div className="compile-pack-item" style={{ padding: "10px 12px" }}>
                  <div className="compile-pack-item-header">
                    <strong>Risk Evidence</strong>
                  </div>
                  <p className="compile-state-text">
                    {typeof detail.run.guardrails.riskEvidenceCount === "number"
                      ? detail.run.guardrails.riskEvidenceCount
                      : "-"}
                  </p>
                </div>
              </div>
              <article className="compile-pack-item">
                <div className="compile-pack-item-header">
                  <strong>Coverage Funnel</strong>
                </div>
                <p className="compile-state-text">
                  queries {detail.coverage.length} {"->"} hits {totalHits} {"->"} support{" "}
                  {supportCoverage.reduce((sum, trace) => sum + trace.hitCount, 0)} {"->"} evidence{" "}
                  {selectedEvidence.length}
                </p>
              </article>
              <KnowledgeAssessmentPanel trace={detail.run.confidenceTrace} />
              <KnowledgePriorPanel
                trace={detail.run.confidenceTrace}
                traceKey="knowledgePrior"
                title="Knowledge Prior"
                missingText="This decision does not include a retrieval-scoped Knowledge Prior."
              />
              <KnowledgePriorPanel
                trace={detail.run.confidenceTrace}
                traceKey="corpusKnowledgePrior"
                title="Corpus Knowledge Prior"
                missingText="This decision does not include a generated corpus Knowledge Prior."
              />
              <OutcomePredictorPanel trace={detail.run.confidenceTrace} />
            </div>
          </div>
        </section>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Feedback</h3>
            <Badge variant="outline">{detail.run.humanFeedback ?? "none"}</Badge>
          </div>
          <div className="compile-feedback-actions">
            <Button
              type="button"
              size="sm"
              disabled={feedbackPending}
              onClick={() => onFeedback(detail.run.id, "good")}
            >
              Good
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={feedbackPending}
              onClick={() => onFeedback(detail.run.id, "bad")}
            >
              Bad
            </Button>
          </div>

          {detail.feedback.length > 0 ? (
            <div className="compile-pack-items">
              {detail.feedback.map((feedback) => (
                <article key={feedback.id} className="compile-pack-item">
                  <div className="compile-pack-item-header">
                    <strong>{feedback.outcome}</strong>
                    <div className="compile-pack-item-meta">
                      <span>{feedback.source}</span>
                      <time>{tzFormatDate(feedback.createdAt, tz)}</time>
                    </div>
                  </div>
                  <p>{feedback.inferredReason}</p>
                </article>
              ))}
            </div>
          ) : null}

          {detail.effects.length > 0 ? (
            <div className="compile-pack-items">
              {detail.effects.map((effect) => (
                <article key={effect.id} className="compile-pack-item">
                  <div className="compile-pack-item-header">
                    <strong>
                      {effect.effect} {effect.amount}
                    </strong>
                    <div className="compile-pack-item-meta">
                      <span>{effect.status}</span>
                      <span>{effect.confidence}% confidence</span>
                    </div>
                  </div>
                  <p>{effect.reason}</p>
                  {effect.knowledgeId ? (
                    <code className="compile-pack-item-id">{effect.knowledgeId}</code>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}
        </section>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Knowledge Used</h3>
            <Badge variant="outline">{detail.evidence.length}</Badge>
          </div>
          {detail.evidence.length === 0 ? (
            <p className="compile-state-text">No evidence recorded for this decision.</p>
          ) : (
            <div className="compile-pack-items">
              {Object.entries(evidenceByRole).map(([role, items]) => (
                <section key={role} className="compile-pack-section">
                  <div className="compile-pack-section-header">
                    <h3>{role}</h3>
                    <Badge variant="secondary">{items.length}</Badge>
                  </div>
                  <div className="compile-pack-items">
                    {items.map((item) => {
                      const summary = splitEvidenceSummary(item.summary);
                      const knowledgeStatus = metadataString(item.metadata, "status");
                      const knowledgeType = metadataString(item.metadata, "type");
                      const relatedEffect = detail.effects.find(
                        (effect) => effect.knowledgeId === item.knowledgeId,
                      );
                      return (
                        <article
                          key={item.id}
                          className="compile-pack-item"
                          style={{ padding: 16 }}
                        >
                          <div className="compile-pack-item-header">
                            <strong>{summary.title}</strong>
                            <div className="compile-pack-item-meta">
                              <Badge
                                variant={
                                  evidenceUsageLabel(item.role) === "used" ? "secondary" : "outline"
                                }
                              >
                                {evidenceUsageLabel(item.role)}
                              </Badge>
                              {knowledgeType ? (
                                <Badge variant="secondary">{knowledgeType}</Badge>
                              ) : null}
                              {knowledgeStatus === "deprecated" ? (
                                <Badge variant="destructive">deprecated</Badge>
                              ) : knowledgeStatus ? (
                                <Badge variant="outline">{knowledgeStatus}</Badge>
                              ) : null}
                              {relatedEffect?.effect === "penalize" ? (
                                <Badge variant="destructive">wrong / off-topic signal</Badge>
                              ) : relatedEffect?.effect === "boost" ? (
                                <Badge variant="secondary">positive signal</Badge>
                              ) : null}
                              <Badge variant="outline">{item.weightAtDecision}% confidence</Badge>
                            </div>
                          </div>

                          <p
                            className="compile-pack-item-id"
                            style={{
                              fontSize: 11,
                              color: "#6b7280",
                              fontFamily: "monospace",
                              margin: "2px 0 6px 0",
                            }}
                          >
                            id: {item.knowledgeId ?? "none"}
                          </p>

                          <p
                            className="compile-pack-item-content"
                            style={{
                              whiteSpace: "pre-wrap",
                              fontSize: 14,
                              lineHeight: 1.6,
                              color: "#374151",
                            }}
                          >
                            {summary.body}
                          </p>

                          {item.sourceRefs.length > 0 ? (
                            <ul className="compile-source-list">
                              {item.sourceRefs.map((ref) => (
                                <li key={ref}>{ref}</li>
                              ))}
                            </ul>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Coverage Trace</h3>
            <Badge variant="outline">{detail.coverage.length}</Badge>
          </div>
          {detail.coverage.length === 0 ? (
            <p className="compile-state-text">No coverage trace recorded for this decision.</p>
          ) : (
            <div className="compile-pack-items">
              {detail.coverage.map((trace) => (
                <article key={trace.id} className="compile-pack-item">
                  <div className="compile-pack-item-header">
                    <strong>{trace.queryRole}</strong>
                    <div className="compile-pack-item-meta">
                      <span>{trace.hitCount} hits</span>
                      <span>{trace.maxSimilarity ?? "-"} max similarity</span>
                    </div>
                  </div>
                  <p>{trace.query}</p>
                  <p>{trace.reason}</p>
                  <div className="compile-code-badge-list">
                    {trace.selectedKnowledgeIds.map((id) => (
                      <code key={id}>selected {id}</code>
                    ))}
                    {trace.rejectedKnowledgeIds.map((id) => (
                      <code key={id}>rejected {id}</code>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function filterRuns(
  runs: ContextDecisionRunSummary[],
  statusFilter: DecisionStatusFilter,
  feedbackFilter: DecisionFeedbackFilter,
) {
  return runs.filter((run) => {
    if (statusFilter !== "all" && run.status !== statusFilter) return false;
    if (feedbackFilter === "none" && run.humanFeedback !== null) return false;
    if (
      feedbackFilter !== "all" &&
      feedbackFilter !== "none" &&
      run.humanFeedback !== feedbackFilter
    ) {
      return false;
    }
    return true;
  });
}

export function ContextDecisionPage() {
  const [mode, setMode] = useState<PageMode>("new");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DecisionStatusFilter>("all");
  const [feedbackFilter, setFeedbackFilter] = useState<DecisionFeedbackFilter>("all");
  const runsQuery = useContextDecisionRuns(50);
  const runs = runsQuery.data ?? [];
  const filteredRuns = useMemo(
    () => filterRuns(runs, statusFilter, feedbackFilter),
    [runs, statusFilter, feedbackFilter],
  );

  useEffect(() => {
    if (mode !== "detail") return;
    if (!selectedRunId && filteredRuns[0]) {
      setSelectedRunId(filteredRuns[0].id);
    }
    if (selectedRunId && !filteredRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(filteredRuns[0]?.id ?? null);
    }
  }, [filteredRuns, mode, selectedRunId]);

  const createDecision = useCreateContextDecisionMutation();
  const detailQuery = useContextDecisionDetail(mode === "detail" ? selectedRunId : null);
  const feedbackMutation = useContextDecisionFeedbackMutation();

  const submitDecision = async (input: ContextDecisionRequest) => {
    const result = await createDecision.mutateAsync(input);
    setSelectedRunId(result.decisionId);
    setMode("detail");
    return result;
  };

  return (
    <div className="context-compiler-shell">
      <ContextDecisionRunSidebar
        runs={filteredRuns}
        selectedRunId={selectedRunId}
        statusFilter={statusFilter}
        feedbackFilter={feedbackFilter}
        isLoading={runsQuery.isLoading}
        error={runsQuery.error}
        onNew={() => {
          setSelectedRunId(null);
          setMode("new");
        }}
        onRefresh={() => {
          void runsQuery.refetch();
        }}
        onSelectRun={(runId) => {
          setSelectedRunId(runId);
          setMode("detail");
        }}
        onStatusFilterChange={setStatusFilter}
        onFeedbackFilterChange={setFeedbackFilter}
      />

      <main className="compile-main">
        <div className="compile-page-title">
          <div className="header-title">
            <h1>Context Decision Control Plane</h1>
            <Badge variant="outline">contextStill</Badge>
          </div>
        </div>

        {mode === "new" ? (
          <DecisionRequestPane
            pending={createDecision.isPending}
            error={createDecision.error}
            onSubmit={submitDecision}
          />
        ) : (
          <DecisionDetailPane
            key={selectedRunId ?? "context-decision-detail"}
            detail={detailQuery.data}
            isLoading={detailQuery.isLoading}
            error={detailQuery.error}
            feedbackPending={feedbackMutation.isPending}
            onFeedback={(decisionId, value) => feedbackMutation.mutate({ decisionId, value })}
          />
        )}
      </main>
    </div>
  );
}
