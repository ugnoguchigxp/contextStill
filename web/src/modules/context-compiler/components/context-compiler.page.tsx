import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import {
  AlertTriangle,
  Brain,
  FileText,
  Gauge,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useCompilePack,
  useCompileRunDetail,
  useCompileRuns,
} from "../hooks/context-compiler.hooks";
import type {
  CompileIntent,
  CompileMode,
  CompilePack,
  CompilePackItem,
  CompileRunDetail,
  CompileRunSelectedItem,
  CompileRunSource,
  CompileRunSummary,
} from "../repositories/context-compiler.repository";

type FormValues = {
  goal: string;
  intent: CompileIntent;
  retrievalMode: "" | CompileMode;
  includeDraft: boolean;
  filesCsv: string;
};

type PageMode = "new" | "detail";
type StatusFilter = "all" | CompileRunSummary["status"];
type SourceFilter = "all" | CompileRunSource;

const statusVariant = {
  ok: "success",
  degraded: "warning",
  failed: "destructive",
} as const;

const sourceLabels: Record<CompileRunSource, string> = {
  ui: "UI",
  mcp: "MCP",
  cli: "CLI",
  unknown: "Unknown",
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function formatLatency(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function metric(label: string, value: ReactNode) {
  return (
    <div className="compile-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ status }: { status: CompileRunSummary["status"] }) {
  return <Badge variant={statusVariant[status]}>{status}</Badge>;
}

function SourceBadge({ source }: { source: CompileRunSource }) {
  return <Badge variant="secondary">{sourceLabels[source]}</Badge>;
}

function RunListItem({
  run,
  active,
  onSelect,
}: {
  run: CompileRunSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`compile-run-item${active ? " active" : ""}`}
      onClick={onSelect}
    >
      <div className="compile-run-item-top">
        <span className="compile-run-title">{run.goal}</span>
        <StatusBadge status={run.status} />
      </div>
      <div className="compile-run-meta">
        <SourceBadge source={run.source} />
        <span>{run.intent}</span>
        <span>{run.retrievalMode}</span>
        <span>{formatLatency(run.durationMs)}</span>
      </div>
      <time>{formatDate(run.createdAt)}</time>
    </button>
  );
}

function RunSidebar({
  runs,
  activeRunId,
  sourceFilter,
  statusFilter,
  isLoading,
  error,
  onNew,
  onRefresh,
  onSelect,
  onSourceFilterChange,
  onStatusFilterChange,
}: {
  runs: CompileRunSummary[];
  activeRunId: string | null;
  sourceFilter: SourceFilter;
  statusFilter: StatusFilter;
  isLoading: boolean;
  error: unknown;
  onNew: () => void;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
  onSourceFilterChange: (value: SourceFilter) => void;
  onStatusFilterChange: (value: StatusFilter) => void;
}) {
  return (
    <aside className="compile-sidebar">
      <div className="compile-sidebar-header">
        <div>
          <h2>Recent Runs</h2>
          <p>{runs.length} visible</p>
        </div>
        <div className="compile-sidebar-actions">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onRefresh}
            title="Refresh"
            aria-label="Refresh runs"
          >
            <RefreshCw size={16} />
          </Button>
          <Button type="button" size="sm" onClick={onNew}>
            <Plus size={16} />
            New
          </Button>
        </div>
      </div>

      <div className="compile-filter-row">
        <Select
          aria-label="Source filter"
          value={sourceFilter}
          onChange={(event) => onSourceFilterChange(event.currentTarget.value as SourceFilter)}
        >
          <option value="all">All sources</option>
          <option value="ui">UI</option>
          <option value="mcp">MCP</option>
          <option value="cli">CLI</option>
          <option value="unknown">Unknown</option>
        </Select>
        <Select
          aria-label="Status filter"
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.currentTarget.value as StatusFilter)}
        >
          <option value="all">All status</option>
          <option value="ok">ok</option>
          <option value="degraded">degraded</option>
          <option value="failed">failed</option>
        </Select>
      </div>

      {isLoading ? <p className="compile-state-text">Loading...</p> : null}
      {error ? <p className="compile-state-text destructive">{String(error)}</p> : null}

      <div className="compile-run-list">
        {runs.map((run) => (
          <RunListItem
            key={run.id}
            run={run}
            active={activeRunId === run.id}
            onSelect={() => onSelect(run.id)}
          />
        ))}
        {!isLoading && runs.length === 0 ? (
          <div className="compile-empty-state">No compile runs match the filters.</div>
        ) : null}
      </div>
    </aside>
  );
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
      intent: "edit",
      retrievalMode: "",
      includeDraft: false,
      filesCsv: "",
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
              rows={8}
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
              <h3>Options</h3>
            </div>
            <div className="compile-form-grid">
              <div className="grid gap-2">
                <Label htmlFor="intent">Intent</Label>
                <Select id="intent" {...register("intent")}>
                  <option value="plan">plan</option>
                  <option value="edit">edit</option>
                  <option value="debug">debug</option>
                  <option value="review">review</option>
                  <option value="finish">finish</option>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="retrievalMode">Retrieval Mode</Label>
                <Select id="retrievalMode" {...register("retrievalMode")}>
                  <option value="">auto</option>
                  <option value="task_context">task_context</option>
                  <option value="review_context">review_context</option>
                  <option value="debug_context">debug_context</option>
                  <option value="architecture_context">architecture_context</option>
                  <option value="procedure_context">procedure_context</option>
                  <option value="learning_context">learning_context</option>
                </Select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="files">Files</Label>
              <Input id="files" placeholder="src/a.ts, src/b.ts" {...register("filesCsv")} />
            </div>

            <Label htmlFor="includeDraft" className="compile-draft-toggle">
              <Checkbox id="includeDraft" {...register("includeDraft")} />
              <span>include draft rules / procedures</span>
            </Label>
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

function TimelineStep({
  icon,
  title,
  children,
  tone,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  tone?: "warning";
}) {
  return (
    <section className={`compile-timeline-step${tone === "warning" ? " warning" : ""}`}>
      <div className="compile-timeline-icon">{icon}</div>
      <div className="compile-timeline-body">
        <h3>{title}</h3>
        {children}
      </div>
    </section>
  );
}

function SourceRefsList({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <ul className="compile-source-list">
      {refs.map((ref) => (
        <li key={ref}>{ref}</li>
      ))}
    </ul>
  );
}

function PackSection({ title, items }: { title: string; items: CompilePackItem[] }) {
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
          {items.map((item) => (
            <article key={item.id} className="compile-pack-item">
              <div className="compile-pack-item-header">
                <strong>{item.title}</strong>
                <Badge variant="secondary">{item.itemKind}</Badge>
              </div>
              <p>{item.content}</p>
              <div className="compile-pack-item-meta">
                <span>{item.rankingReason}</span>
                <span>{Math.round(item.score * 1000) / 1000}</span>
              </div>
              <SourceRefsList refs={item.sourceRefs} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LegacySnapshotNotice({
  selectedItems,
}: {
  selectedItems: CompileRunSelectedItem[];
}) {
  return (
    <div className="compile-empty-state">
      <strong>Snapshot unavailable</strong>
      <p>
        This run was recorded before pack snapshot persistence. The original title, content, and
        diagnostics cannot be reconstructed.
      </p>
      {selectedItems.length > 0 ? (
        <div className="compile-selected-items">
          {selectedItems.map((item) => (
            <div key={`${item.section}:${item.itemKind}:${item.itemId}`}>
              <span>{item.section}</span>
              <strong>{item.itemId}</strong>
              <small>{item.rankingReason}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunDetailHeader({ detail }: { detail: CompileRunDetail }) {
  return (
    <div className="compile-detail-header">
      <div>
        <h2>{detail.run.goal}</h2>
        <div className="compile-run-meta">
          <SourceBadge source={detail.run.source} />
          <StatusBadge status={detail.run.status} />
          <span>{detail.run.intent}</span>
          <span>{detail.run.retrievalMode}</span>
          <span>{formatLatency(detail.run.durationMs)}</span>
        </div>
      </div>
      <time>{formatDate(detail.run.createdAt)}</time>
    </div>
  );
}

function Timeline({ detail, pack }: { detail: CompileRunDetail; pack: CompilePack }) {
  const stats = asRecord(pack.diagnostics.retrievalStats);
  const knowledgeStats = asRecord(stats.knowledge);
  const sourceStats = asRecord(stats.sources);
  const errorContext = asRecord(stats.errorContext);
  const input = asRecord(detail.run.input);
  const lastErrorContext = asRecord(input.lastErrorContext);
  const lastErrorFiles = stringArrayValue(lastErrorContext.files);
  const files = stringArrayValue(input.files);
  const suggestedNextCalls = stringArrayValue(stats.suggestedNextCalls);
  const agenticReasoning = stringValue(stats.agenticReasoning);
  const tokenBudget = numberValue(stats.tokenBudget);
  const compileDurationMs = numberValue(stats.compileDurationMs);
  const hasBudgetWarning = pack.diagnostics.degradedReasons.includes(
    "TOKEN_BUDGET_SECTION_LIMIT_REACHED",
  );
  const hasAgenticWarning = pack.diagnostics.degradedReasons.includes("AGENTIC_REFINE_FAILED");

  return (
    <div className="compile-timeline">
      <TimelineStep icon={<Terminal size={17} />} title="Input">
        <div className="compile-metric-grid">
          {metric("intent", detail.run.intent)}
          {metric("mode", detail.run.retrievalMode)}
          {metric("source", sourceLabels[detail.run.source])}
          {metric("token budget", tokenBudget ?? detail.run.tokenBudget)}
        </div>
        {files.length > 0 ? (
          <div className="compile-code-badge-list">
            {files.map((file) => (
              <code key={file}>{file}</code>
            ))}
          </div>
        ) : null}
      </TimelineStep>

      <TimelineStep icon={<Search size={17} />} title="Retrieval">
        <div className="compile-metric-grid">
          {metric("rules", pack.rules.length)}
          {metric("procedures", pack.procedures.length)}
          {metric("code context", pack.codeContext.length)}
          {metric("knowledge text", numberValue(knowledgeStats.textHitCount) ?? 0)}
          {metric("knowledge vector", numberValue(knowledgeStats.vectorHitCount) ?? 0)}
          {metric("knowledge merged", numberValue(knowledgeStats.mergedCount) ?? 0)}
          {metric("source hits", numberValue(sourceStats.hitCount) ?? 0)}
          {metric("source vector", numberValue(sourceStats.vectorHitCount) ?? 0)}
        </div>
      </TimelineStep>

      <TimelineStep icon={<AlertTriangle size={17} />} title="Error Context">
        <div className="compile-metric-grid">
          {metric("kind", stringValue(input.errorKind) ?? "Not supplied")}
          {metric("keywords", numberValue(errorContext.keywordCount) ?? 0)}
          {metric("file hints", numberValue(errorContext.fileHintCount) ?? 0)}
          {metric("command", stringValue(lastErrorContext.command) ?? "Not supplied")}
        </div>
        {lastErrorFiles.length > 0 ? (
          <div className="compile-code-badge-list">
            {lastErrorFiles.map((file) => (
              <code key={file}>{file}</code>
            ))}
          </div>
        ) : null}
      </TimelineStep>

      <TimelineStep
        icon={<Brain size={17} />}
        title="Agentic Refine"
        tone={hasAgenticWarning ? "warning" : undefined}
      >
        <div className="compile-metric-grid">
          {metric("used", stats.agenticUsed === true ? "yes" : "no")}
          {metric("warning", hasAgenticWarning ? "failed" : "none")}
        </div>
        {agenticReasoning ? <p className="compile-reasoning">{agenticReasoning}</p> : null}
      </TimelineStep>

      <TimelineStep
        icon={<Gauge size={17} />}
        title="Budget"
        tone={hasBudgetWarning ? "warning" : undefined}
      >
        <div className="compile-metric-grid">
          {metric("token budget", tokenBudget ?? detail.run.tokenBudget)}
          {metric("latency", formatLatency(compileDurationMs ?? detail.run.durationMs))}
          {metric("status", detail.run.status)}
          {metric("section limit", hasBudgetWarning ? "reached" : "not reached")}
        </div>
      </TimelineStep>

      <TimelineStep icon={<FileText size={17} />} title="Output">
        <div className="compile-pack-output">
          {pack.minimalTasks.length > 0 ? (
            <section className="compile-pack-section">
              <div className="compile-pack-section-header">
                <h3>Minimal Tasks</h3>
                <Badge variant="outline">{pack.minimalTasks.length}</Badge>
              </div>
              <ul className="compile-task-list">
                {pack.minimalTasks.map((task) => (
                  <li key={task}>{task}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <PackSection title="Rules" items={pack.rules} />
          <PackSection title="Procedures" items={pack.procedures} />
          <PackSection title="Code Context" items={pack.codeContext} />
          {pack.warnings.length > 0 ? (
            <section className="compile-pack-section">
              <div className="compile-pack-section-header">
                <h3>Warnings</h3>
                <Badge variant="warning">{pack.warnings.length}</Badge>
              </div>
              <ul className="compile-task-list">
                {pack.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {pack.diagnostics.degradedReasons.length > 0 ? (
            <section className="compile-pack-section">
              <div className="compile-pack-section-header">
                <h3>Degraded Reasons</h3>
                <Badge variant="warning">{pack.diagnostics.degradedReasons.length}</Badge>
              </div>
              <div className="compile-code-badge-list">
                {pack.diagnostics.degradedReasons.map((reason) => (
                  <code key={reason}>{reason}</code>
                ))}
              </div>
            </section>
          ) : null}
          {suggestedNextCalls.length > 0 ? (
            <section className="compile-pack-section">
              <div className="compile-pack-section-header">
                <h3>Suggested Next Calls</h3>
                <Badge variant="outline">{suggestedNextCalls.length}</Badge>
              </div>
              <div className="compile-code-badge-list">
                {suggestedNextCalls.map((call) => (
                  <code key={call}>{call}</code>
                ))}
              </div>
            </section>
          ) : null}
          <section className="compile-pack-section">
            <div className="compile-pack-section-header">
              <h3>Source Refs</h3>
              <Badge variant="outline">{pack.sourceRefs.length}</Badge>
            </div>
            <SourceRefsList refs={pack.sourceRefs} />
          </section>
        </div>
      </TimelineStep>
    </div>
  );
}

function RunDetailPane({
  detail,
  isLoading,
  error,
}: {
  detail: CompileRunDetail | undefined;
  isLoading: boolean;
  error: unknown;
}) {
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

  return (
    <Card className="compile-main-card">
      <CardContent>
        <RunDetailHeader detail={detail} />
        {detail.pack ? (
          <Timeline detail={detail} pack={detail.pack} />
        ) : (
          <LegacySnapshotNotice selectedItems={detail.selectedItems} />
        )}
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
    const files = values.filesCsv
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const pack = await compile.mutateAsync({
      goal: values.goal,
      intent: values.intent,
      retrievalMode: values.retrievalMode || undefined,
      includeDraft: values.includeDraft,
      files: files.length > 0 ? files : undefined,
    });
    setActiveRunId(pack.runId);
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
          <RunDetailPane detail={detail.data} isLoading={detail.isLoading} error={detail.error} />
        )}
      </main>
    </div>
  );
}
