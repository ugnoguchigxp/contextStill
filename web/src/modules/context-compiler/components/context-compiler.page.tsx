import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { asRecord, parseCsvListOptional } from "@/lib/data-utils";
import { Settings2 } from "lucide-react";
import { MarkdownEditor } from "markdown-wysiwyg-editor";
import mermaid from "mermaid";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import {
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from "recharts";
import {
  useCompilePack,
  useCompileRunDetail,
  useCompileRuns,
  useRunKnowledgeFeedbackMutation,
} from "../hooks/context-compiler.hooks";
import type {
  CompilePackItem,
  CompileResponse,
  CompileRunDetail,
  CompileRunKnowledgeFeedbackResult,
  CompileRunKnowledgeFeedbackWriteItem,
  CompileRunKnowledgeVerdict,
  CompileRunKnowledgeSignal,
  CompileRunSource,
  CompileRunSummary,
} from "../repositories/context-compiler.repository";
import { useTimezone, formatDate as tzFormatDate } from "@/lib/timezone";
import {
  formatLatency,
  RunSidebar,
  SourceBadge,
  StatusBadge,
} from "./context-compiler.run-sidebar";

type FormValues = {
  goal: string;
  changeTypesCsv: string;
  technologiesCsv: string;
  domainsCsv: string;
};

type PageMode = "new" | "detail";
type StatusFilter = "all" | CompileRunSummary["status"];
type SourceFilter = "all" | CompileRunSource;

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

function CompileFormPane({
  compilePending,
  compileError,
  onSubmit,
}: {
  compilePending: boolean;
  compileError: unknown;
  onSubmit: (values: FormValues) => Promise<void>;
}) {
  const { register, handleSubmit, formState } = useForm<FormValues>({
    defaultValues: {
      goal: "",
      changeTypesCsv: "",
      technologiesCsv: "",
      domainsCsv: "",
    },
  });

  return (
    <Card className="compile-main-card compile-prompt-card">
      <CardContent>
        <form className="compile-form" onSubmit={handleSubmit(onSubmit)}>
          <div className="compile-prompt-header">
            <div>
              <Badge variant="secondary" className="type-badge">
                context pack
              </Badge>
              <h2>Goal</h2>
            </div>
            <span>UI source</span>
          </div>

          <div className="compile-goal-editor">
            <Label htmlFor="goal">Goal</Label>
            <Textarea
              id="goal"
              rows={7}
              placeholder="Describe the task"
              {...register("goal", { required: "Goal is required." })}
            />
            {formState.errors.goal ? (
              <p className="text-destructive text-xs">{formState.errors.goal.message}</p>
            ) : null}
          </div>

          <section className="compile-options-panel" aria-label="Compile options">
            <div className="compile-options-title">
              <Settings2 size={16} />
              <h3>Facets</h3>
            </div>
            <div className="compile-form-grid">
              <div className="grid gap-2">
                <Label htmlFor="changeTypesCsv">Change Types</Label>
                <Input
                  id="changeTypesCsv"
                  placeholder="feature, refactor, review"
                  {...register("changeTypesCsv")}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="technologiesCsv">Technologies</Label>
                <Input
                  id="technologiesCsv"
                  placeholder="typescript, react, drizzle"
                  {...register("technologiesCsv")}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="domainsCsv">Domains</Label>
              <Input
                id="domainsCsv"
                placeholder="context-compiler, knowledge, mcp-tools"
                {...register("domainsCsv")}
              />
            </div>
          </section>

          <div className="compile-form-actions">
            <Button type="submit" disabled={compilePending || formState.isSubmitting}>
              {compilePending ? "Compiling..." : "Compile"}
            </Button>
            {compileError ? (
              <p className="text-destructive text-sm">{String(compileError)}</p>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SourceRefsList({ refs }: { refs: string[] }) {
  if (refs.length === 0) return <p className="compile-state-text">None</p>;
  const uniqueRefs = useMemo(() => Array.from(new Set(refs)), [refs]);
  return (
    <ul className="compile-source-list">
      {uniqueRefs.map((ref) => (
        <li key={ref}>{ref}</li>
      ))}
    </ul>
  );
}

function PackSection({
  title,
  items,
  signals,
  onFeedback,
  feedbackPending,
}: {
  title: string;
  items: CompilePackItem[];
  signals: CompileRunKnowledgeSignal[];
  onFeedback: (knowledgeId: string, verdict: CompileRunKnowledgeVerdict) => Promise<void>;
  feedbackPending: boolean;
}) {
  return (
    <section className="compile-pack-section">
      <div className="compile-pack-section-header">
        <h3>{title}</h3>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="compile-state-text">None</p>
      ) : (
        <div className="compile-pack-items">
          {items.map((item) => {
            const sig = signals.find((s) => s.knowledgeId === item.itemId);
            return (
              <article key={item.id} className="compile-pack-item" style={{ padding: "16px" }}>
                <div className="compile-pack-item-header">
                  <strong>{item.title}</strong>
                  <Badge variant="secondary">{item.itemKind}</Badge>
                </div>
                
                {/* 常に表示する Knowledge ID */}
                <p className="compile-pack-item-id" style={{ fontSize: "11px", color: "#6b7280", fontFamily: "monospace", margin: "2px 0 6px 0" }}>
                  id: {item.itemId}
                </p>

                {/* タグ (changeTypes, technologies, domains) の描画 */}
                {(item.changeTypes?.length || item.technologies?.length || item.domains?.length) ? (
                  <p style={{ fontSize: "14px", color: "#6b7280", margin: "4px 0 10px 0", lineHeight: "1.6" }}>
                    {item.changeTypes?.length ? (
                      <span>
                        <strong style={{ color: "#374151" }}>Change Type:</strong>{" "}
                        {item.changeTypes.join(", ")}
                      </span>
                    ) : null}
                    {item.changeTypes?.length && (item.technologies?.length || item.domains?.length) ? "　" : null}
                    {item.technologies?.length ? (
                      <span>
                        <strong style={{ color: "#374151" }}>Technology:</strong>{" "}
                        {item.technologies.join(", ")}
                      </span>
                    ) : null}
                    {item.technologies?.length && item.domains?.length ? "　" : null}
                    {item.domains?.length ? (
                      <span>
                        <strong style={{ color: "#374151" }}>Domain:</strong>{" "}
                        {item.domains.join(", ")}
                      </span>
                    ) : null}
                  </p>
                ) : null}

                <p className="compile-pack-item-content" style={{ whiteSpace: "pre-wrap", fontSize: "14px", lineHeight: "1.6", color: "#374151" }}>{item.content}</p>
                <div className="compile-pack-item-signal-info" style={{ marginTop: "12px", borderTop: "1px solid rgba(0,0,0,0.05)", paddingTop: "12px" }}>
                  {sig ? (
                    <>
                      <div className="compile-pack-item-meta" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "8px" }}>
                        <Badge variant={feedbackVariant(sig.effectiveVerdict)}>
                          {sig.effectiveVerdict
                            ? verdictLabel(sig.effectiveVerdict)
                            : "No signal"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{sig.rankingReason || item.rankingReason}</span>
                      </div>

                      {sig.hasUserOverride && sig.autoVerdict ? (
                        <p className="text-xs text-muted-foreground" style={{ margin: "4px 0" }}>
                          Auto: {verdictLabel(sig.autoVerdict)}
                          {sig.autoReason ? ` (${sig.autoReason})` : ""}
                        </p>
                      ) : null}

                      {sig.effectiveReason ? (
                        <p className="text-xs text-muted-foreground" style={{ margin: "4px 0" }}>
                          Signal: {sig.effectiveReason}
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  <div className="compile-feedback-actions" style={{ display: "flex", gap: "8px", marginTop: sig ? "8px" : "0" }}>
                    <Button
                      type="button"
                      size="sm"
                      variant={sig?.effectiveVerdict === "used" ? "default" : "outline"}
                      onClick={() => void onFeedback(sig?.knowledgeId ?? item.itemId, "used")}
                      disabled={feedbackPending}
                    >
                      Used
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={sig?.effectiveVerdict === "not_used" ? "default" : "outline"}
                      onClick={() => void onFeedback(sig?.knowledgeId ?? item.itemId, "not_used")}
                      disabled={feedbackPending}
                    >
                      Not used
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={sig?.effectiveVerdict === "off_topic" ? "default" : "outline"}
                      onClick={() => void onFeedback(sig?.knowledgeId ?? item.itemId, "off_topic")}
                      disabled={feedbackPending}
                    >
                      Off-topic
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={sig?.effectiveVerdict === "wrong" ? "default" : "outline"}
                      onClick={() => void onFeedback(sig?.knowledgeId ?? item.itemId, "wrong")}
                      disabled={feedbackPending}
                    >
                      Wrong
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function facetLine(label: string, values: string[]) {
  if (values.length === 0) return null;
  return (
    <p className="compile-state-text">
      <strong>{label}</strong> {values.join(", ")}
    </p>
  );
}

function hasLegacyInput(input: Record<string, unknown>): boolean {
  return ["intent", "files", "repoPath", "lastErrorContext", "errorKind"].some(
    (key) => key in input,
  );
}

function verdictLabel(verdict: CompileRunKnowledgeVerdict): string {
  if (verdict === "used") return "Used in output";
  if (verdict === "not_used") return "Selected, not referenced";
  if (verdict === "off_topic") return "Marked off-topic";
  return "Needs review";
}

function feedbackVariant(current: CompileRunKnowledgeVerdict | null) {
  if (current === "wrong") return "destructive" as const;
  if (current === "off_topic") return "secondary" as const;
  if (current === "not_used") return "outline" as const;
  return "default" as const;
}

function evalOutcomeLabel(outcome: "useful" | "partial" | "misleading" | "unused"): string {
  if (outcome === "useful") return "Useful";
  if (outcome === "partial") return "Partial";
  if (outcome === "misleading") return "Misleading";
  return "Unused";
}

function EvaluationRadarChart({
  relevance,
  actionability,
  coverage,
  noise,
  specificity,
}: {
  relevance: number;
  actionability: number;
  coverage: number;
  noise: number;
  specificity: number;
}) {
  const data = [
    { subject: "目的適合性 (Relevance)", value: relevance },
    { subject: "実行可能性 (Actionability)", value: actionability },
    { subject: "網羅性 (Coverage)", value: coverage },
    { subject: "ノイズ削減 (Noise)", value: noise },
    { subject: "具体性 (Specificity)", value: specificity },
  ];

  return (
    <div
      className="evaluation-radar-chart-container"
      style={{
        width: "100%",
        height: "240px",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        margin: "8px 0",
        padding: "8px",
        background: "rgba(0, 0, 0, 0.01)",
        borderRadius: "12px",
        border: "1px solid rgba(0, 0, 0, 0.06)",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.04)",
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart
          cx="50%"
          cy="50%"
          outerRadius="60%"
          data={data}
          margin={{ top: 10, right: 30, bottom: 10, left: 30 }}
        >
          <PolarGrid stroke="rgba(0, 0, 0, 0.08)" gridType="polygon" />
          <PolarAngleAxis
            dataKey="subject"
            tick={{ fill: "#1f2937", fontSize: 11, fontWeight: 600 }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tick={{ fill: "#4b5563", fontSize: 10, fontWeight: 500 }}
            axisLine={false}
          />
          <Radar
            name="評価スコア"
            dataKey="value"
            stroke="#7c3aed"
            fill="#7c3aed"
            fillOpacity={0.15}
            strokeWidth={2}
            dot={{ r: 4, fill: "#a78bfa", stroke: "#ffffff", strokeWidth: 1.5 }}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RunDetailPane({
  detail,
  isLoading,
  error,
  onSubmitKnowledgeFeedback,
  feedbackPending,
}: {
  detail: CompileRunDetail | undefined;
  isLoading: boolean;
  error: unknown;
  onSubmitKnowledgeFeedback: (
    runId: string,
    items: CompileRunKnowledgeFeedbackWriteItem[],
  ) => Promise<CompileRunKnowledgeFeedbackResult>;
  feedbackPending: boolean;
}) {
  const tz = useTimezone();
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

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
          <div className="compile-empty-state">Select a compile run.</div>
        </CardContent>
      </Card>
    );
  }

  const input = asRecord(detail.run.input);
  const changeTypes = stringArrayValue(input.changeTypes);
  const technologies = stringArrayValue(input.technologies);
  const domains = stringArrayValue(input.domains);
  const outputMarkdown = detail.outputMarkdown?.trim() || "No Content";
  const knowledgeSignals = detail.knowledgeSignals ?? [];
  const evaluations = detail.evaluations ?? [];

  const applyKnowledgeFeedback = async (
    knowledgeId: string,
    verdict: CompileRunKnowledgeVerdict,
  ) => {
    try {
      const result = await onSubmitKnowledgeFeedback(detail.run.id, [{ knowledgeId, verdict }]);
      setFeedbackMessage(
        `saved=${result.savedCount}, updated=${result.updatedCount}, queue+${result.queueCreatedCount}, queue-dismissed=${result.queueDismissedCount}`,
      );
    } catch (submitError) {
      setFeedbackMessage(
        submitError instanceof Error ? submitError.message : "Failed to save knowledge feedback",
      );
    }
  };

  return (
    <Card className="compile-main-card">
      <CardContent>
        <div className="compile-detail-header">
          <div>
            <h2>{detail.run.goal}</h2>
            <div className="compile-run-meta">
              <StatusBadge status={detail.run.status} />
              <SourceBadge source={detail.run.source} />
              <span>{detail.run.retrievalMode}</span>
              <span>{formatLatency(detail.run.durationMs)}</span>
            </div>
          </div>
          <time>{tzFormatDate(detail.run.createdAt, tz)}</time>
        </div>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Compiled Output</h3>
          </div>
          <div className="compile-output-markdown">
            <MarkdownEditor
              value={outputMarkdown}
              editable={false}
              toolbarMode="hidden"
              enableVerticalScroll
              enableMermaid
              mermaidLib={mermaid}
            />
          </div>
        </section>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Input Facets</h3>
          </div>
          {facetLine("changeTypes:", changeTypes)}
          {facetLine("technologies:", technologies)}
          {facetLine("domains:", domains)}
          {changeTypes.length === 0 && technologies.length === 0 && domains.length === 0 ? (
            <p className="compile-state-text">Goal only</p>
          ) : null}
        </section>

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Compile Eval</h3>
            <Badge variant="outline">{evaluations.length}</Badge>
          </div>
          {evaluations.length === 0 ? (
            <p className="compile-state-text">No compile_eval records for this run.</p>
          ) : (
            <div className="compile-pack-items">
              {evaluations.map((evaluation) => {
                const hasDetails = [
                  evaluation.relevance,
                  evaluation.actionability,
                  evaluation.coverage,
                  evaluation.noise,
                  evaluation.specificity,
                ].every((val) => val !== null && val !== undefined);

                return (
                  <article key={evaluation.id} className="compile-pack-item" style={{ padding: "16px" }}>
                    <div className="compile-pack-item-header" style={{ marginBottom: "12px" }}>
                      <strong>{evaluation.title ?? "Evaluation"}</strong>
                      <Badge variant="secondary">
                        Avg: {evaluation.avg} / {evalOutcomeLabel(evaluation.outcome)}
                      </Badge>
                    </div>

                    {hasDetails ? (
                      <div className="compile-eval-layout" style={{ display: "grid", gridTemplateColumns: "1.1fr 1.2fr", gap: "24px", alignItems: "center" }}>
                        <div className="compile-eval-left">
                          <EvaluationRadarChart
                            relevance={evaluation.relevance!}
                            actionability={evaluation.actionability!}
                            coverage={evaluation.coverage!}
                            noise={evaluation.noise!}
                            specificity={evaluation.specificity!}
                          />
                        </div>
                        <div className="compile-eval-right" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "100%", minHeight: "220px", padding: "8px 0" }}>
                          <p style={{ fontSize: "14px", lineHeight: "1.6", color: "#374151", whiteSpace: "pre-wrap", flexGrow: 1, margin: 0 }}>
                            {evaluation.body}
                          </p>
                          <div className="compile-pack-item-meta" style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px solid rgba(0, 0, 0, 0.05)" }}>
                            <span>source: {evaluation.source}</span>
                            <span>{tzFormatDate(evaluation.createdAt, tz)}</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <p style={{ fontSize: "14px", lineHeight: "1.6", color: "#374151", whiteSpace: "pre-wrap" }}>
                          {evaluation.body}
                        </p>
                        <div className="compile-pack-item-meta">
                          <span>source: {evaluation.source}</span>
                          <span>{tzFormatDate(evaluation.createdAt, tz)}</span>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {detail.pack ? (
          <>
            <section className="compile-pack-section">
              <div className="compile-pack-section-header">
                <h3>Selected Knowledge (Audit)</h3>
              </div>
              <p className="compile-state-text">
                Compiled Output生成時に選ばれた候補を監査目的で表示しています。
              </p>
            </section>
            <PackSection
              title="Rules"
              items={detail.pack.rules}
              signals={knowledgeSignals}
              onFeedback={applyKnowledgeFeedback}
              feedbackPending={feedbackPending}
            />
            <PackSection
              title="Procedures"
              items={detail.pack.procedures}
              signals={knowledgeSignals}
              onFeedback={applyKnowledgeFeedback}
              feedbackPending={feedbackPending}
            />
            {feedbackMessage ? (
              <div style={{ padding: "0 8px 16px" }}>
                <p className="compile-state-text">{feedbackMessage}</p>
              </div>
            ) : null}
            {detail.pack.diagnostics.degradedReasons.length > 0 ? (
              <section className="compile-pack-section">
                <div className="compile-pack-section-header">
                  <h3>Degraded Reasons</h3>
                  <Badge variant="warning">{detail.pack.diagnostics.degradedReasons.length}</Badge>
                </div>
                <div className="compile-code-badge-list">
                  {detail.pack.diagnostics.degradedReasons.map((reason) => (
                    <code key={reason}>{reason}</code>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : (
          <section className="compile-pack-section">
            <p className="compile-state-text">Snapshot unavailable for this legacy run.</p>
          </section>
        )}

        {hasLegacyInput(input) ? (
          <section className="compile-pack-section">
            <div className="compile-pack-section-header">
              <h3>Legacy Input Detail</h3>
            </div>
            <pre className="knowledge-json-preview">{JSON.stringify(input, null, 2)}</pre>
          </section>
        ) : null}

        <section className="compile-pack-section">
          <div className="compile-pack-section-header">
            <h3>Source Refs (Audit)</h3>
            <Badge variant="outline">{detail.pack?.sourceRefs.length ?? 0}</Badge>
          </div>
          <SourceRefsList refs={detail.pack?.sourceRefs ?? []} />
        </section>
      </CardContent>
    </Card>
  );
}

export function ContextCompilerPage() {
  const [mode, setMode] = useState<PageMode>("new");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const compile = useCompilePack();
  const runKnowledgeFeedback = useRunKnowledgeFeedbackMutation();
  const runs = useCompileRuns(50);
  const detail = useCompileRunDetail(mode === "detail" ? activeRunId : null);

  const filteredRuns = useMemo(() => {
    return (runs.data ?? []).filter((run) => {
      if (sourceFilter !== "all" && run.source !== sourceFilter) return false;
      if (statusFilter !== "all" && run.status !== statusFilter) return false;
      return true;
    });
  }, [runs.data, sourceFilter, statusFilter]);

  const onSubmit = async (values: FormValues) => {
    const response: CompileResponse = await compile.mutateAsync({
      goal: values.goal,
      changeTypes: parseCsvListOptional(values.changeTypesCsv),
      technologies: parseCsvListOptional(values.technologiesCsv),
      domains: parseCsvListOptional(values.domainsCsv),
    });
    setActiveRunId(response.pack.runId);
    setMode("detail");
  };

  return (
    <div className="context-compiler-shell">
      <RunSidebar
        runs={filteredRuns}
        activeRunId={activeRunId}
        sourceFilter={sourceFilter}
        statusFilter={statusFilter}
        isLoading={runs.isLoading}
        error={runs.error}
        onNew={() => {
          setActiveRunId(null);
          setMode("new");
        }}
        onRefresh={() => {
          void runs.refetch();
        }}
        onSelect={(runId) => {
          setActiveRunId(runId);
          setMode("detail");
        }}
        onSourceFilterChange={setSourceFilter}
        onStatusFilterChange={setStatusFilter}
      />

      <main className="compile-main">
        <div className="compile-page-title">
          <div className="header-title">
            <h1>Context Compiler Control Plane</h1>
            <Badge variant="outline">memory-router</Badge>
          </div>
        </div>
        {mode === "new" ? (
          <CompileFormPane
            compilePending={compile.isPending}
            compileError={compile.error}
            onSubmit={onSubmit}
          />
        ) : (
          <RunDetailPane
            key={activeRunId ?? "compile-run-detail"}
            detail={detail.data}
            isLoading={detail.isLoading}
            error={detail.error}
            feedbackPending={runKnowledgeFeedback.isPending}
            onSubmitKnowledgeFeedback={(runId, items) =>
              runKnowledgeFeedback.mutateAsync({
                runId,
                items,
              })
            }
          />
        )}
      </main>
    </div>
  );
}
