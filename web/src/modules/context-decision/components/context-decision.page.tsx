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
  useContextDecisionDetail,
  useContextDecisionFeedbackMutation,
  useContextDecisionRuns,
  useCreateContextDecisionMutation,
} from "../hooks/context-decision.hooks";
import type {
  ContextDecisionEvidence,
  ContextDecisionKnowledgeAssessment,
  ContextDecisionKnowledgePrior,
  ContextDecisionMlSignal,
  ContextDecisionReliabilityGate,
  ContextDecisionRequest,
  ContextDecisionResult,
  ContextDecisionRunDetail,
  ContextDecisionRunSummary,
} from "../repositories/context-decision.repository";
import {
  ContextDecisionRunSidebar,
  DecisionBadge,
  type DecisionFeedbackFilter,
  DecisionStatusBadge,
  type DecisionStatusFilter,
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

function metadataNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function evidenceUsageLabel(role: ContextDecisionEvidence["role"]): string {
  if (role === "counter_evidence") return "counter";
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

function traceRecord(trace: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = trace[key];
  return isRecord(value) ? value : null;
}

function traceRecordArray(
  trace: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const value = trace[key];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function signalVariant(
  label: string,
): "default" | "secondary" | "destructive" | "outline" | null | undefined {
  if (
    label.includes("wrong") ||
    label.includes("off-topic") ||
    label.includes("negative") ||
    label.includes("dead")
  ) {
    return "destructive";
  }
  if (label.includes("not-used") || label.includes("not used")) {
    return "outline";
  }
  if (label.includes("strong") || label.includes("useful") || label.includes("used")) {
    return "secondary";
  }
  return "outline";
}

type CompileSignalStats = {
  used: number;
  notUsed: number;
  wrong: number;
  offTopic: number;
  suppressed: number;
  selected: number;
};

function compileSignalStats(item: ContextDecisionEvidence): CompileSignalStats {
  const signals = isRecord(item.metadata.signals) ? item.metadata.signals : {};
  const compile = isRecord(signals.compile) ? signals.compile : {};
  return {
    used: metadataNumber(compile, "usedCount") ?? 0,
    notUsed: metadataNumber(compile, "notUsedCount") ?? 0,
    wrong: metadataNumber(compile, "wrongCount") ?? 0,
    offTopic: metadataNumber(compile, "offTopicCount") ?? 0,
    suppressed: metadataNumber(compile, "suppressedCount") ?? 0,
    selected: metadataNumber(compile, "compileSelectCount") ?? 0,
  };
}

function roleTitle(role: ContextDecisionEvidence["role"]): string {
  if (role === "selected_support") return "Used as support";
  if (role === "user_preference") return "User preference";
  if (role === "risk_warning") return "Used as risk";
  if (role === "counter_evidence") return "Counter evidence";
  if (role === "rejected_alternative") return "Rejected / not used";
  return "Missing counter evidence";
}

function roleBadgeVariant(
  role: ContextDecisionEvidence["role"],
): "default" | "secondary" | "destructive" | "outline" | null | undefined {
  if (role === "selected_support" || role === "user_preference") return "secondary";
  if (role === "risk_warning") return "destructive";
  return "outline";
}

function CompileHistoryBar({ item }: { item: ContextDecisionEvidence }) {
  const stats = compileSignalStats(item);
  const entries = [
    { label: "Used", value: stats.used, color: "#16a34a" },
    { label: "Not used", value: stats.notUsed, color: "#9ca3af" },
    { label: "Wrong", value: stats.wrong, color: "#dc2626" },
    { label: "Off-topic", value: stats.offTopic, color: "#d97706" },
  ];
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  const hasCompileHistory = total > 0 || stats.suppressed > 0 || stats.selected > 0;

  return (
    <div style={{ marginTop: 12 }}>
      <div className="compile-pack-item-header">
        <strong style={{ fontSize: 12 }}>Compile history</strong>
        {stats.selected > 0 ? <Badge variant="outline">selected {stats.selected}</Badge> : null}
      </div>
      {total > 0 ? (
        <div
          aria-label={`Compile history: Used ${stats.used}, Not used ${stats.notUsed}, Wrong ${stats.wrong}, Off-topic ${stats.offTopic}`}
          style={{
            display: "flex",
            height: 10,
            overflow: "hidden",
            borderRadius: 999,
            background: "#e5e7eb",
            marginTop: 8,
          }}
        >
          {entries
            .filter((entry) => entry.value > 0)
            .map((entry) => (
              <div
                key={entry.label}
                title={`${entry.label} ${entry.value}`}
                style={{
                  width: `${Math.max(6, (entry.value / total) * 100)}%`,
                  background: entry.color,
                }}
              />
            ))}
        </div>
      ) : (
        <p className="compile-state-text" style={{ marginTop: 8 }}>
          No compile usage history recorded.
        </p>
      )}
      {hasCompileHistory ? (
        <div className="compile-code-badge-list" style={{ marginTop: 8 }}>
          {entries.map((entry) => (
            <code key={entry.label}>
              {entry.label} {entry.value}
            </code>
          ))}
          {stats.suppressed > 0 ? <code>Suppressed {stats.suppressed}</code> : null}
        </div>
      ) : null}
    </div>
  );
}

function evidenceSignalLabels(item: ContextDecisionEvidence): string[] {
  const signals = isRecord(item.metadata.signals) ? item.metadata.signals : {};
  const compile = isRecord(signals.compile) ? signals.compile : {};
  const landscape = isRecord(signals.landscape) ? signals.landscape : {};
  const community = isRecord(signals.community) ? signals.community : {};
  const health = isRecord(community.health) ? community.health : {};
  const labels: string[] = [];
  const wrongCount = metadataNumber(compile, "wrongCount");
  const offTopicCount = metadataNumber(compile, "offTopicCount");
  const usedCount = metadataNumber(compile, "usedCount");
  const notUsedCount = metadataNumber(compile, "notUsedCount");
  const suppressedCount = metadataNumber(compile, "suppressedCount");
  const classification = metadataString(landscape, "classification");
  const communityLabel = metadataString(community, "communityLabel");

  if (wrongCount && wrongCount > 0) labels.push(`compile wrong ${wrongCount}`);
  if (offTopicCount && offTopicCount > 0) labels.push(`compile off-topic ${offTopicCount}`);
  if (usedCount && usedCount > 0) labels.push(`compile used ${usedCount}`);
  if (notUsedCount && notUsedCount > 0) labels.push(`compile not-used ${notUsedCount}`);
  if (suppressedCount && suppressedCount > 0) labels.push(`suppressed ${suppressedCount}`);
  if (classification) labels.push(`landscape ${classification}`);
  if (communityLabel) labels.push(`community ${communityLabel}`);
  if (health.dead === true) labels.push("dead community");
  if (health.stale === true) labels.push("stale community");
  if (health.thinEvidence === true) labels.push("thin evidence");
  const topicalRelevanceScore = metadataNumber(item.metadata, "topicalRelevanceScore");
  const roleFit = isRecord(item.metadata.roleFit)
    ? metadataString(item.metadata.roleFit, "classification")
    : null;
  const selectionStage = metadataString(item.metadata, "selectionStage");
  if (typeof topicalRelevanceScore === "number") labels.push(`relevance ${topicalRelevanceScore}`);
  if (roleFit) labels.push(`role ${roleFit}`);
  if (selectionStage) labels.push(selectionStage);

  return labels.slice(0, 6);
}

function feedbackEffectTitle(effect: ContextDecisionRunDetail["effects"][number]): string {
  if (effect.effect === "penalize") return "Bad feedback penalty";
  if (effect.effect === "boost") return "Good feedback boost";
  return "Feedback note";
}

function feedbackEffectVariant(
  effect: ContextDecisionRunDetail["effects"][number],
): "default" | "secondary" | "destructive" | "outline" | null | undefined {
  if (effect.effect === "penalize") return "destructive";
  if (effect.effect === "boost") return "secondary";
  return "outline";
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
  if (value.source !== "retrieval_prior_v1") return null;
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

function reliabilityRuleSeverity(
  value: unknown,
): ContextDecisionReliabilityGate["appliedRules"][number]["severity"] {
  return value === "blocking" || value === "warning" || value === "info" ? value : "info";
}

function asReliabilityGate(value: unknown): ContextDecisionReliabilityGate | null {
  if (!isRecord(value)) return null;
  if (value.status !== "passed" && value.status !== "constrained") return null;
  const riskEvidence = isRecord(value.riskEvidence) ? value.riskEvidence : {};
  const badFeedback = isRecord(value.badFeedback) ? value.badFeedback : {};
  const evidenceCoverage = isRecord(value.evidenceCoverage) ? value.evidenceCoverage : {};
  const operationalImpact = isRecord(value.operationalImpact) ? value.operationalImpact : null;
  const appliedRules = Array.isArray(value.appliedRules)
    ? value.appliedRules
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          key: typeof item.key === "string" ? item.key : "unknown",
          severity: reliabilityRuleSeverity(item.severity),
          message: typeof item.message === "string" ? item.message : "-",
        }))
    : [];
  const toNumber = (record: Record<string, unknown>, key: string) => {
    const raw = record[key];
    return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 0;
  };
  const gate: ContextDecisionReliabilityGate = {
    status: value.status,
    originalDecision:
      typeof value.originalDecision === "string"
        ? (value.originalDecision as ContextDecisionReliabilityGate["originalDecision"])
        : "execute",
    finalDecision:
      typeof value.finalDecision === "string"
        ? (value.finalDecision as ContextDecisionReliabilityGate["finalDecision"])
        : "execute",
    confidenceCap:
      typeof value.confidenceCap === "number" && Number.isFinite(value.confidenceCap)
        ? Math.round(value.confidenceCap)
        : null,
    appliedRules,
    riskEvidence: {
      count: toNumber(riskEvidence, "count"),
      forcedDisplay: riskEvidence.forcedDisplay === true,
      titles: Array.isArray(riskEvidence.titles)
        ? riskEvidence.titles.filter((item): item is string => typeof item === "string")
        : [],
    },
    badFeedback: {
      count: toNumber(badFeedback, "count"),
      strongCount: toNumber(badFeedback, "strongCount"),
      averageConfidence: toNumber(badFeedback, "averageConfidence"),
      maxConfidence: toNumber(badFeedback, "maxConfidence"),
    },
    evidenceCoverage: {
      assessmentStatus:
        typeof evidenceCoverage.assessmentStatus === "string"
          ? (evidenceCoverage.assessmentStatus as ContextDecisionReliabilityGate["evidenceCoverage"]["assessmentStatus"])
          : "failed",
      supportEvidenceCount: toNumber(evidenceCoverage, "supportEvidenceCount"),
      riskEvidenceCount: toNumber(evidenceCoverage, "riskEvidenceCount"),
      knowledgeCoverage: toNumber(evidenceCoverage, "knowledgeCoverage"),
    },
  };
  if (operationalImpact) {
    const operationType =
      operationalImpact.operationType === "process_restart" ||
      operationalImpact.operationType === "destructive_change" ||
      operationalImpact.operationType === "unknown"
        ? operationalImpact.operationType
        : "unknown";
    const level =
      operationalImpact.level === "low" ||
      operationalImpact.level === "medium" ||
      operationalImpact.level === "high" ||
      operationalImpact.level === "unknown"
        ? operationalImpact.level
        : "unknown";
    const optionalNumber = (key: string) => {
      const raw = operationalImpact[key];
      return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
    };
    gate.operationalImpact = {
      operationType,
      level,
      activeLeaseCount: optionalNumber("activeLeaseCount"),
      impactedUserEstimate: optionalNumber("impactedUserEstimate"),
      reason:
        typeof operationalImpact.reason === "string"
          ? operationalImpact.reason
          : "No impact reason recorded.",
      autonomousGoRecommended: operationalImpact.autonomousGoRecommended === true,
    };
  }
  return gate;
}

function traceStringArray(trace: Record<string, unknown>, key: string): string[] {
  const value = trace[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function decisionStateVariant(
  value: string,
): "default" | "secondary" | "destructive" | "outline" | null | undefined {
  if (
    value.includes("blocked") ||
    value.includes("risk") ||
    value.includes("constrained") ||
    value.includes("failed") ||
    value.includes("weak") ||
    value.includes("high")
  ) {
    return "destructive";
  }
  if (
    value.includes("passed") ||
    value.includes("strong") ||
    value.includes("clear") ||
    value.includes("low") ||
    value.includes("medium")
  ) {
    return "secondary";
  }
  return "outline";
}

function DecisionRationalePanel({
  detail,
  selectedSupportCount,
  counterCount,
  riskCount,
  totalHits,
}: {
  detail: ContextDecisionRunDetail;
  selectedSupportCount: number;
  counterCount: number;
  riskCount: number;
  totalHits: number;
}) {
  const trace = detail.run.confidenceTrace;
  const assessment = asKnowledgeAssessment(trace.knowledgeAssessment);
  const gate = asReliabilityGate(trace.reliabilityGate);
  const confidenceCaps = traceRecordArray(trace, "confidenceCaps");
  const forcedRules = traceStringArray(trace, "forcedRules");
  const signalStatus = traceRecord(trace, "signalStatus");
  const primaryStrength = traceString(trace, "primaryEvidenceStrength") ?? "unknown";
  const signalState = typeof signalStatus?.status === "string" ? signalStatus.status : "unknown";
  const riskState = riskCount > 0 || counterCount > 0 ? "risk present" : "risk clear";
  const gateState = gate?.status ?? "not recorded";
  const impact = gate?.operationalImpact;
  const evidenceState =
    selectedSupportCount > 0
      ? primaryStrength === "verified" || primaryStrength === "observed"
        ? "evidence strong"
        : "evidence partial"
      : "evidence weak";
  const rationaleRows = [
    assessment
      ? `Knowledge Assessment recommends ${assessment.recommendedDirection} because ${assessment.reason}`
      : "Knowledge Assessment was not recorded for this run.",
    gate
      ? gate.status === "constrained"
        ? `Reliability Gate changed ${gate.originalDecision} -> ${gate.finalDecision}.`
        : `Reliability Gate passed with final decision ${gate.finalDecision}.`
      : "Reliability Gate was not recorded.",
    impact
      ? `Operational impact was estimated as ${impact.level} for ${impact.operationType}; active leases=${impact.activeLeaseCount ?? "unknown"}, impacted users=${impact.impactedUserEstimate ?? "unknown"}. ${impact.reason}`
      : "Operational impact estimate was not recorded.",
    counterCount > 0 || riskCount > 0
      ? `${counterCount} counter item(s) and ${riskCount} risk item(s) were selected as decision constraints.`
      : "No selected counter or risk evidence is attached to this decision.",
    confidenceCaps.length > 0
      ? `Confidence was capped by ${confidenceCaps
          .map((item) => (typeof item.key === "string" ? item.key : "cap"))
          .join(", ")}.`
      : forcedRules.length > 0
        ? `Forced rule(s): ${forcedRules.join(", ")}.`
        : "No confidence cap or forced rule was applied.",
  ];

  return (
    <section className="compile-pack-section">
      <div className="compile-pack-section-header">
        <h3>Decision Rationale</h3>
        <Badge variant={gate?.status === "constrained" ? "destructive" : "secondary"}>
          {detail.run.decision}
        </Badge>
      </div>
      <div className="compile-pack-item">
        <div className="compile-code-badge-list">
          {[
            gateState,
            evidenceState,
            riskState,
            `signals ${signalState}`,
            impact ? `impact ${impact.level}` : null,
          ]
            .filter((item): item is string => Boolean(item))
            .map((item) => (
              <Badge key={item} variant={decisionStateVariant(item)}>
                {item}
              </Badge>
            ))}
        </div>
        <ul className="compile-source-list" style={{ marginTop: 12 }}>
          {rationaleRows.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      </div>
      <div className="compile-metric-grid">
        <Metric label="Queries" value={detail.coverage.length} />
        <Metric label="Candidates Found" value={totalHits} />
        <Metric label="Support Used" value={selectedSupportCount} />
        <Metric label="Counter / Risk" value={`${counterCount} / ${riskCount}`} />
        <Metric label="Final Gate" value={gate?.finalDecision ?? detail.run.decision} />
        <Metric label="Impact" value={impact?.level ?? "not recorded"} />
      </div>
    </section>
  );
}

function ReliabilityGatePanel({ trace }: { trace: Record<string, unknown> }) {
  const gate = asReliabilityGate(trace.reliabilityGate);
  if (!gate) {
    return (
      <article className="compile-pack-item">
        <div className="compile-pack-item-header">
          <strong>Reliability Gate</strong>
          <Badge variant="outline">not recorded</Badge>
        </div>
        <p className="compile-state-text">
          This older decision does not include reliability gate trace data.
        </p>
      </article>
    );
  }

  return (
    <article className="compile-pack-item">
      <div className="compile-pack-item-header">
        <strong>Reliability Gate</strong>
        <div className="compile-pack-item-meta">
          <Badge variant={gate.status === "constrained" ? "destructive" : "secondary"}>
            {gate.status}
          </Badge>
          {gate.confidenceCap !== null ? (
            <Badge variant="outline">cap {gate.confidenceCap}%</Badge>
          ) : null}
        </div>
      </div>
      <div className="compile-metric-grid" style={{ marginTop: 8 }}>
        <Metric label="Original" value={gate.originalDecision} />
        <Metric label="Final" value={gate.finalDecision} />
        <Metric label="Coverage" value={`${gate.evidenceCoverage.knowledgeCoverage}%`} />
        <Metric label="Strong Bad Feedback" value={gate.badFeedback.strongCount} />
      </div>
      {gate.operationalImpact ? (
        <div className="compile-pack-item" style={{ marginTop: 10, padding: "10px 12px" }}>
          <div className="compile-pack-item-header">
            <strong>Operational Impact</strong>
            <div className="compile-pack-item-meta">
              <Badge variant="outline">{gate.operationalImpact.operationType}</Badge>
              <Badge variant={decisionStateVariant(gate.operationalImpact.level)}>
                {gate.operationalImpact.level}
              </Badge>
              {gate.operationalImpact.autonomousGoRecommended ? (
                <Badge variant="secondary">autonomous GO</Badge>
              ) : (
                <Badge variant="destructive">NO-GO</Badge>
              )}
            </div>
          </div>
          <div className="compile-metric-grid" style={{ marginTop: 8 }}>
            <Metric
              label="Active Leases"
              value={gate.operationalImpact.activeLeaseCount ?? "unknown"}
            />
            <Metric
              label="Impacted Users"
              value={gate.operationalImpact.impactedUserEstimate ?? "unknown"}
            />
          </div>
          <p className="compile-state-text" style={{ marginTop: 8 }}>
            {gate.operationalImpact.reason}
          </p>
        </div>
      ) : null}
      {gate.appliedRules.length > 0 ? (
        <div className="compile-pack-items" style={{ marginTop: 10 }}>
          {gate.appliedRules.map((rule) => (
            <div key={rule.key} className="compile-pack-item" style={{ padding: "10px 12px" }}>
              <div className="compile-pack-item-header">
                <strong>{rule.key}</strong>
                <Badge variant={rule.severity === "blocking" ? "destructive" : "outline"}>
                  {rule.severity}
                </Badge>
              </div>
              <p className="compile-state-text">{rule.message}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="compile-state-text" style={{ marginTop: 10 }}>
          No reliability constraints were applied.
        </p>
      )}
    </article>
  );
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
  traceKey: "knowledgePrior";
  title: string;
  missingText: string;
}) {
  const prior = asKnowledgePrior(trace[traceKey]);
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
      <div className="compile-metric-grid" style={{ marginTop: 8 }}>
        <Metric label="Evidence" value={prior.evidenceCount} />
        <Metric label="Candidates" value={prior.candidateCount} />
      </div>
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

function PrimaryEvidencePanel({ trace }: { trace: Record<string, unknown> }) {
  const primaryEvidence = traceRecordArray(trace, "primaryEvidence");
  if (primaryEvidence.length === 0) {
    return (
      <article className="compile-pack-item">
        <div className="compile-pack-item-header">
          <strong>Primary Evidence</strong>
          <Badge variant="outline">not recorded</Badge>
        </div>
        <p className="compile-state-text">No first-class primary evidence was stored.</p>
      </article>
    );
  }
  return (
    <article className="compile-pack-item">
      <div className="compile-pack-item-header">
        <strong>Primary Evidence</strong>
        <Badge variant="secondary">{primaryEvidence.length}</Badge>
      </div>
      <div className="compile-pack-items" style={{ marginTop: 10 }}>
        {primaryEvidence.slice(0, 4).map((item, index) => (
          <div
            key={`${item.title}:${index}`}
            className="compile-pack-item"
            style={{ padding: "10px 12px" }}
          >
            <div className="compile-pack-item-header">
              <strong>{typeof item.title === "string" ? item.title : "Evidence"}</strong>
              <div className="compile-pack-item-meta">
                <Badge variant="outline">
                  {typeof item.kind === "string" ? item.kind : "other"}
                </Badge>
                <Badge variant={item.strength === "verified" ? "secondary" : "outline"}>
                  {typeof item.strength === "string" ? item.strength : "claimed"}
                </Badge>
              </div>
            </div>
            <p className="compile-state-text">
              {typeof item.summary === "string" ? item.summary : "-"}
            </p>
          </div>
        ))}
      </div>
    </article>
  );
}

function EpisodePrecedentsPanel({ trace }: { trace: Record<string, unknown> }) {
  const precedents = traceRecordArray(trace, "episodePrecedents");
  if (precedents.length === 0) {
    return (
      <article className="compile-pack-item">
        <div className="compile-pack-item-header">
          <strong>EpisodeCard Precedents</strong>
          <Badge variant="outline">not recorded</Badge>
        </div>
        <p className="compile-state-text">No similar EpisodeCard precedents were stored.</p>
      </article>
    );
  }
  return (
    <article className="compile-pack-item">
      <div className="compile-pack-item-header">
        <strong>EpisodeCard Precedents</strong>
        <Badge variant="secondary">{precedents.length}</Badge>
      </div>
      <div className="compile-pack-items" style={{ marginTop: 10 }}>
        {precedents.slice(0, 4).map((item) => (
          <div
            key={typeof item.episodeId === "string" ? item.episodeId : String(item.title)}
            className="compile-pack-item"
            style={{ padding: "10px 12px" }}
          >
            <div className="compile-pack-item-header">
              <strong>{typeof item.title === "string" ? item.title : "Episode"}</strong>
              <div className="compile-pack-item-meta">
                <Badge variant={item.usedFor === "risk_cap" ? "destructive" : "outline"}>
                  {typeof item.usedFor === "string" ? item.usedFor : "background"}
                </Badge>
                <Badge variant="outline">
                  relevance{" "}
                  {typeof item.topicalRelevanceScore === "number"
                    ? Math.round(item.topicalRelevanceScore)
                    : 0}
                </Badge>
              </div>
            </div>
            <p className="compile-state-text">
              {typeof item.lesson === "string" && item.lesson
                ? item.lesson
                : typeof item.situation === "string"
                  ? item.situation
                  : "-"}
            </p>
          </div>
        ))}
      </div>
    </article>
  );
}

function RankingTraceSummaryPanel({ trace }: { trace: Record<string, unknown> }) {
  const confidenceCaps = traceRecordArray(trace, "confidenceCaps");
  const candidateTraces = traceRecordArray(trace, "candidateTraces");
  const lowRelevanceSelected = candidateTraces.filter(
    (item) =>
      item.selected === true &&
      typeof item.topicalRelevanceScore === "number" &&
      item.topicalRelevanceScore < 70,
  ).length;
  return (
    <article className="compile-pack-item">
      <div className="compile-pack-item-header">
        <strong>Selection Quality</strong>
        <Badge variant={lowRelevanceSelected > 0 ? "destructive" : "secondary"}>
          low relevance selected {lowRelevanceSelected}
        </Badge>
      </div>
      <div className="compile-metric-grid" style={{ marginTop: 8 }}>
        <Metric label="Direct Evidence" value={`${traceNumber(trace, "directEvidenceRatio")}%`} />
        <Metric label="Role Fit" value={`${traceNumber(trace, "roleFitPassRate")}%`} />
        <Metric label="Topical Avg" value={`${traceNumber(trace, "topicalRelevanceAverage")}%`} />
        <Metric label="Episode Risk" value={traceNumber(trace, "episodePrecedentRisk")} />
      </div>
      {confidenceCaps.length > 0 ? (
        <div className="compile-code-badge-list" style={{ marginTop: 10 }}>
          {confidenceCaps.map((item) => (
            <code key={`${item.key}:${item.cap}`}>
              {typeof item.key === "string" ? item.key : "cap"}{" "}
              {typeof item.cap === "number" ? item.cap : 0}
            </code>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function DecisionSignalSummaryPanel({ trace }: { trace: Record<string, unknown> }) {
  const signalStatus = traceRecord(trace, "signalStatus");
  const compileSignals = traceRecord(trace, "compileSignals");
  const communitySignals = traceRecord(trace, "communitySignals");
  const landscapeSignals = traceRecord(trace, "landscapeSignals");
  if (!signalStatus && !compileSignals && !communitySignals && !landscapeSignals) {
    return (
      <article className="compile-pack-item">
        <div className="compile-pack-item-header">
          <strong>Decision Signals</strong>
          <Badge variant="outline">not recorded</Badge>
        </div>
        <p className="compile-state-text">No persisted decision signals were recorded.</p>
      </article>
    );
  }

  return (
    <article className="compile-pack-item">
      <div className="compile-pack-item-header">
        <strong>Decision Signals</strong>
        <Badge variant={signalStatus?.status === "failed" ? "destructive" : "secondary"}>
          {typeof signalStatus?.status === "string" ? signalStatus.status : "recorded"}
        </Badge>
      </div>
      <div className="compile-metric-grid">
        <Metric label="Evidence" value={metadataNumber(signalStatus ?? {}, "evidenceCount")} />
        <Metric label="Compile" value={metadataNumber(signalStatus ?? {}, "compileSignalCount")} />
        <Metric
          label="Community"
          value={metadataNumber(signalStatus ?? {}, "communitySignalCount")}
        />
        <Metric
          label="Landscape"
          value={metadataNumber(signalStatus ?? {}, "landscapeSignalCount")}
        />
      </div>
      {typeof signalStatus?.reason === "string" ? (
        <p className="compile-state-text">{signalStatus.reason}</p>
      ) : null}
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

function KnowledgeEvidencePanel({
  evidence,
  effects,
}: {
  evidence: ContextDecisionEvidence[];
  effects: ContextDecisionRunDetail["effects"];
}) {
  const evidenceByRole = groupByRole(evidence);
  const roleOrder: ContextDecisionEvidence["role"][] = [
    "selected_support",
    "user_preference",
    "risk_warning",
    "counter_evidence",
    "rejected_alternative",
    "missing_counter_evidence",
  ];
  const orderedRoles = roleOrder.filter((role) => (evidenceByRole[role] ?? []).length > 0);
  return (
    <section className="compile-pack-section">
      <div className="compile-pack-section-header">
        <h3>Knowledge Evidence</h3>
        <Badge variant="outline">{evidence.length}</Badge>
      </div>
      {evidence.length === 0 ? (
        <p className="compile-state-text">No evidence recorded for this decision.</p>
      ) : (
        <div className="compile-pack-items">
          {orderedRoles.map((role) => {
            const items = evidenceByRole[role] ?? [];
            return (
              <section key={role} className="compile-pack-section">
                <div className="compile-pack-section-header">
                  <h3>{roleTitle(role)}</h3>
                  <Badge variant={roleBadgeVariant(role)}>{items.length}</Badge>
                </div>
                <div className="compile-pack-items">
                  {items.map((item) => {
                    const summary = splitEvidenceSummary(item.summary);
                    const knowledgeStatus = metadataString(item.metadata, "status");
                    const knowledgeType = metadataString(item.metadata, "type");
                    const relatedEffect = effects.find(
                      (effect) => effect.knowledgeId === item.knowledgeId,
                    );
                    const signalLabels = evidenceSignalLabels(item);
                    const topicalRelevanceScore = metadataNumber(
                      item.metadata,
                      "topicalRelevanceScore",
                    );
                    const roleFit = isRecord(item.metadata.roleFit)
                      ? metadataString(item.metadata.roleFit, "classification")
                      : null;
                    return (
                      <article key={item.id} className="compile-pack-item" style={{ padding: 16 }}>
                        <div className="compile-pack-item-header">
                          <strong>{summary.title}</strong>
                          <div className="compile-pack-item-meta">
                            <Badge variant={roleBadgeVariant(item.role)}>
                              {evidenceUsageLabel(item.role)}
                            </Badge>
                            <Badge variant="outline">{item.weightAtDecision}% weight</Badge>
                            {knowledgeType ? (
                              <Badge variant="secondary">{knowledgeType}</Badge>
                            ) : null}
                            {knowledgeStatus === "deprecated" ? (
                              <Badge variant="destructive">deprecated</Badge>
                            ) : knowledgeStatus ? (
                              <Badge variant="outline">{knowledgeStatus}</Badge>
                            ) : null}
                            {relatedEffect?.effect === "penalize" ? (
                              <Badge variant="destructive">negative feedback</Badge>
                            ) : relatedEffect?.effect === "boost" ? (
                              <Badge variant="secondary">positive feedback</Badge>
                            ) : null}
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

                        <div className="compile-code-badge-list" style={{ marginTop: 10 }}>
                          {typeof topicalRelevanceScore === "number" ? (
                            <code>Relevance {topicalRelevanceScore}</code>
                          ) : null}
                          {roleFit ? <code>Role fit {roleFit}</code> : null}
                          {signalLabels.map((label) => (
                            <Badge key={`${item.id}:${label}`} variant={signalVariant(label)}>
                              {label}
                            </Badge>
                          ))}
                        </div>

                        <CompileHistoryBar item={item} />

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
            );
          })}
        </div>
      )}
    </section>
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
  const selectedEvidence = (detail?.evidence ?? []).filter(
    (item) => item.role === "selected_support" || item.role === "user_preference",
  );
  const counterEvidence = (detail?.evidence ?? []).filter(
    (item) => item.role === "counter_evidence",
  );
  const riskEvidence = (detail?.evidence ?? []).filter((item) => item.role === "risk_warning");
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

        <DecisionRationalePanel
          detail={detail}
          selectedSupportCount={selectedEvidence.length}
          counterCount={counterEvidence.length}
          riskCount={riskEvidence.length}
          totalHits={totalHits}
        />

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Decision Summary</h3>
            <Badge variant="outline">{detail.run.status}</Badge>
          </div>
          <div className="compile-metric-grid">
            <Metric label="Decision" value={detail.run.decision} />
            <Metric label="Trace Confidence" value={`${detail.run.confidence}%`} />
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

        <KnowledgeEvidencePanel evidence={detail.evidence} effects={detail.effects} />

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Decision Trace</h3>
            <Badge variant="outline">{selectedEvidence.length} support used</Badge>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 12,
              alignItems: "start",
            }}
          >
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
              <PrimaryEvidencePanel trace={detail.run.confidenceTrace} />
              <EpisodePrecedentsPanel trace={detail.run.confidenceTrace} />
              <RankingTraceSummaryPanel trace={detail.run.confidenceTrace} />
              <DecisionSignalSummaryPanel trace={detail.run.confidenceTrace} />
              <ReliabilityGatePanel trace={detail.run.confidenceTrace} />
              <KnowledgePriorPanel
                trace={detail.run.confidenceTrace}
                traceKey="knowledgePrior"
                title="Knowledge Prior"
                missingText="This decision does not include a retrieval-scoped Knowledge Prior."
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
              <div className="compile-pack-section-header">
                <h3>Feedback Effects</h3>
                <Badge variant="outline">{detail.effects.length}</Badge>
              </div>
              {detail.effects.map((effect) => {
                const affectedEvidence = detail.evidence.find(
                  (item) => item.knowledgeId === effect.knowledgeId,
                );
                const affectedSummary = affectedEvidence
                  ? splitEvidenceSummary(affectedEvidence.summary)
                  : null;
                return (
                  <article key={effect.id} className="compile-pack-item">
                    <div className="compile-pack-item-header">
                      <strong>{feedbackEffectTitle(effect)}</strong>
                      <div className="compile-pack-item-meta">
                        <Badge variant={feedbackEffectVariant(effect)}>
                          {effect.amount > 0 ? `+${effect.amount}` : effect.amount}
                        </Badge>
                        <Badge variant="outline">{effect.status}</Badge>
                        <span>{effect.confidence}% confidence</span>
                      </div>
                    </div>
                    {affectedSummary ? (
                      <>
                        <p className="compile-pack-item-content">{affectedSummary.title}</p>
                        <div className="compile-pack-item-meta">
                          {affectedEvidence ? (
                            <Badge variant="outline">{affectedEvidence.role}</Badge>
                          ) : null}
                          <span>{effect.reason}</span>
                        </div>
                      </>
                    ) : (
                      <p className="compile-state-text">{effect.reason}</p>
                    )}
                  </article>
                );
              })}
            </div>
          ) : null}
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
  const initialRunIdFromQuery = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("runId");
  }, []);
  const [mode, setMode] = useState<PageMode>(initialRunIdFromQuery ? "detail" : "new");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunIdFromQuery);
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
    if (
      selectedRunId &&
      selectedRunId !== initialRunIdFromQuery &&
      !filteredRuns.some((run) => run.id === selectedRunId)
    ) {
      setSelectedRunId(filteredRuns[0]?.id ?? null);
    }
  }, [filteredRuns, initialRunIdFromQuery, mode, selectedRunId]);

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
