import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Plus, RefreshCw, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  CompilePack,
  CompilePackItem,
  CompileRunDetail,
  CompileRunSource,
  CompileRunSummary,
} from "../repositories/context-compiler.repository";

type FormValues = {
  goal: string;
  changeTypesCsv: string;
  technologiesCsv: string;
  domainsCsv: string;
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

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

function parseCsv(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
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
            </article>
          ))}
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

  const input = asRecord(detail.run.input);
  const changeTypes = stringArrayValue(input.changeTypes);
  const technologies = stringArrayValue(input.technologies);
  const domains = stringArrayValue(input.domains);

  return (
    <Card className="compile-main-card">
      <CardContent>
        <div className="compile-detail-header">
          <div>
            <h2>{detail.run.goal}</h2>
            <div className="compile-run-meta">
              <SourceBadge source={detail.run.source} />
              <StatusBadge status={detail.run.status} />
              <span>{detail.run.retrievalMode}</span>
              <span>{formatLatency(detail.run.durationMs)}</span>
            </div>
          </div>
          <time>{formatDate(detail.run.createdAt)}</time>
        </div>

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

        {detail.pack ? (
          <>
            <PackSection title="Rules" items={detail.pack.rules} />
            <PackSection title="Procedures" items={detail.pack.procedures} />
            {detail.pack.warnings.length > 0 ? (
              <section className="compile-pack-section">
                <div className="compile-pack-section-header">
                  <h3>Context Quality</h3>
                  <Badge variant="warning">{detail.pack.warnings.length}</Badge>
                </div>
                <ul className="compile-task-list">
                  {detail.pack.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
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
    const pack = await compile.mutateAsync({
      goal: values.goal,
      changeTypes: parseCsv(values.changeTypesCsv),
      technologies: parseCsv(values.technologiesCsv),
      domains: parseCsv(values.domainsCsv),
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
