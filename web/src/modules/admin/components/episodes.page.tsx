import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatDateTime as tzFormatDateTime, useTimezone } from "@/lib/timezone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ExternalLink, Plus, RefreshCw, Search } from "lucide-react";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import {
  type EpisodeCard,
  type EpisodeCardCreateInput,
  type EpisodeCardStatus,
  type EpisodeOutcomeKind,
  type EpisodeRef,
  type EpisodeRefInput,
  type EpisodeRefKind,
  type EpisodeSourceKind,
  createEpisode,
  fetchEpisode,
  fetchEpisodes,
} from "../repositories/admin.repository";
import { AdminModalShell } from "./admin-modal-shell";
import { AdminPaginationFooter } from "./admin-pagination-footer";
import { AdminSortableTableHead } from "./admin-sortable-table-head";

type EpisodeFormState = {
  title: string;
  sourceKind: EpisodeSourceKind;
  sourceKey: string;
  summary: string;
  takeaway: string;
  outcomeKind: EpisodeOutcomeKind;
  importance: number;
  confidence: number;
  status: EpisodeCardStatus;
  domainsCsv: string;
  technologiesCsv: string;
  changeTypesCsv: string;
  toolsCsv: string;
  refKind: EpisodeRefKind;
  refsText: string;
  queryHint: string;
};

type EpisodeStatusFilter = "active_draft" | EpisodeCardStatus;

const sourceKinds: EpisodeSourceKind[] = [
  "manual",
  "vibe_memory",
  "compile_run",
  "decision_run",
  "audit_log",
];
const refKinds: EpisodeRefKind[] = [
  "vibe_memory",
  "agent_diff",
  "compile_run",
  "decision_run",
  "audit_log",
  "file",
  "commit",
];

const emptyForm = (): EpisodeFormState => ({
  title: "",
  sourceKind: "manual",
  sourceKey: `manual-${new Date().toISOString()}`,
  summary: "",
  takeaway: "",
  outcomeKind: "unknown",
  importance: 50,
  confidence: 50,
  status: "active",
  domainsCsv: "",
  technologiesCsv: "",
  changeTypesCsv: "",
  toolsCsv: "",
  refKind: "vibe_memory",
  refsText: "",
  queryHint: "",
});

const refKindSet = new Set<EpisodeRefKind>(refKinds);
const tableHeadClass = "px-3 py-2 text-xs font-semibold uppercase tracking-wide";
const tableCellClass = "px-3 py-2 align-top whitespace-normal";

function EpisodeColumnGroup() {
  return (
    <colgroup>
      <col className="w-[22%]" />
      <col className="w-[11%]" />
      <col className="w-[7%]" />
      <col className="w-[5%]" />
      <col className="w-[8%]" />
      <col className="w-[9%]" />
      <col className="w-[9%]" />
      <col className="w-[9%]" />
      <col className="w-[7%]" />
      <col className="w-[6%]" />
      <col className="w-[7%]" />
    </colgroup>
  );
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSourceRefs(state: EpisodeFormState): EpisodeRefInput[] {
  return state.refsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      const prefix = separator > 0 ? line.slice(0, separator).trim() : "";
      const hasExplicitKind = refKindSet.has(prefix as EpisodeRefKind);
      const refKind = hasExplicitKind ? (prefix as EpisodeRefKind) : state.refKind;
      const refValue = hasExplicitKind ? line.slice(separator + 1).trim() : line;
      return {
        refKind,
        refValue,
        queryHint: state.queryHint.trim() || undefined,
      };
    })
    .filter((ref) => ref.refValue.length > 0);
}

function toCreateInput(state: EpisodeFormState): EpisodeCardCreateInput {
  return {
    title: state.title.trim(),
    sourceKind: state.sourceKind,
    sourceKey: state.sourceKey.trim(),
    situation: state.summary.trim(),
    lesson: state.takeaway.trim(),
    outcomeKind: state.outcomeKind,
    importance: state.importance,
    confidence: state.confidence,
    status: state.status,
    domains: csv(state.domainsCsv),
    technologies: csv(state.technologiesCsv),
    changeTypes: csv(state.changeTypesCsv),
    tools: csv(state.toolsCsv),
    metadata: { source: "admin_ui_manual", uiSchemaVersion: "episode-card.v2" },
    refs: parseSourceRefs(state),
  };
}

function textPreview(value: string, max = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "-";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function extractRunId(value: string): string {
  const runMatch = value.match(/\/run\/([^/#?]+)/);
  return runMatch?.[1] ?? value;
}

function sourceRefHref(ref: EpisodeRef): string {
  const value = ref.refValue;
  const encoded = encodeURIComponent(value);
  if (ref.refKind === "vibe_memory") {
    return `/vibe-memory?memoryId=${encoded}`;
  }
  if (ref.refKind === "agent_diff") {
    return `/vibe-memory?agentDiffId=${encoded}`;
  }
  if (ref.refKind === "compile_run") {
    return `/compile?runId=${encodeURIComponent(extractRunId(value))}`;
  }
  if (ref.refKind === "decision_run") {
    return `/decision?runId=${encodeURIComponent(extractRunId(value))}`;
  }
  if (ref.refKind === "audit_log") {
    return `/audit?q=${encoded}`;
  }
  if (ref.refKind === "file") {
    if (/^https?:\/\//i.test(value)) return value;
    return `/sources?q=${encoded}`;
  }
  return `/audit?q=${encoded}`;
}

function sourceRefTarget(ref: EpisodeRef): "_blank" | undefined {
  return ref.refKind === "file" && /^https?:\/\//i.test(ref.refValue) ? "_blank" : undefined;
}

function statusVariant(value: EpisodeCardStatus) {
  if (value === "active") return "success";
  if (value === "draft") return "warning";
  return "secondary";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function FacetBadges({
  items,
  limit = 3,
  empty = "-",
}: {
  items: string[];
  limit?: number;
  empty?: string;
}) {
  const visible = items.slice(0, limit);
  const hiddenCount = Math.max(0, items.length - visible.length);
  if (visible.length === 0) {
    return <span className="text-xs text-muted-foreground">{empty}</span>;
  }
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {visible.map((item) => (
        <Badge key={item} variant="outline" className="max-w-full truncate text-[10px]">
          {item}
        </Badge>
      ))}
      {hiddenCount > 0 ? (
        <Badge variant="secondary" className="text-[10px]">
          +{hiddenCount}
        </Badge>
      ) : null}
    </div>
  );
}

function FacetGroup({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
      <div className="mt-2">
        <FacetBadges items={items} limit={12} empty="None" />
      </div>
    </div>
  );
}

function EpisodeDetail({ episode }: { episode: EpisodeCard }) {
  const tz = useTimezone();
  const distillation = recordValue(episode.metadata.episodeDistillation);
  const scores = recordValue(distillation.scores);
  const sourceFragmentKey =
    typeof distillation.sourceFragmentKey === "string" ? distillation.sourceFragmentKey : "";
  const sourceStartOffset =
    typeof distillation.sourceStartOffset === "number" ? distillation.sourceStartOffset : null;
  const sourceEndOffset =
    typeof distillation.sourceEndOffset === "number" ? distillation.sourceEndOffset : null;
  const facts = [
    ["Episode Summary", episode.situation],
    ["Reusable Takeaway", episode.lesson],
  ];
  const auxiliaryFacts = [
    ["Context Notes", episode.observations],
    ["Work Performed", episode.action],
    ["Resulting State", episode.outcome],
  ].filter(([, value]) => value.trim().length > 0);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(episode.status)}>{episode.status}</Badge>
        <Badge variant="outline">{episode.outcomeKind}</Badge>
        <Badge variant="secondary">importance {episode.importance}</Badge>
        <Badge variant="secondary">confidence {episode.confidence}</Badge>
        <Badge variant="outline">compile uses {episode.compileUseCount}</Badge>
        <Badge variant="outline">decision uses {episode.decisionUseCount}</Badge>
      </div>
      <div className="space-y-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
              {value || "-"}
            </p>
          </div>
        ))}
        {auxiliaryFacts.map(([label, value]) => (
          <div key={label}>
            <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
              {value}
            </p>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Source</p>
          <p className="break-words text-sm [overflow-wrap:anywhere]">
            {episode.sourceKind}: {episode.sourceKey}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Created</p>
          <p className="text-sm">{tzFormatDateTime(episode.createdAt, tz)}</p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <FacetGroup label="Technologies" items={episode.technologies} />
        <FacetGroup label="Domains" items={episode.domains} />
        <FacetGroup label="Change types" items={episode.changeTypes} />
        <FacetGroup label="Tools" items={episode.tools} />
      </div>
      {sourceFragmentKey ? (
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Distillation</p>
          <div className="mt-2 space-y-2 text-sm">
            <p className="break-words [overflow-wrap:anywhere]">{sourceFragmentKey}</p>
            {sourceStartOffset !== null && sourceEndOffset !== null ? (
              <p className="text-xs text-muted-foreground">
                bytes:{sourceStartOffset}-{sourceEndOffset}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-1">
              {Object.entries(scores)
                .filter(([, value]) => typeof value === "number")
                .slice(0, 8)
                .map(([key, value]) => (
                  <Badge key={key} variant="outline">
                    {key}: {String(value)}
                  </Badge>
                ))}
            </div>
          </div>
        </div>
      ) : null}
      <div>
        <p className="text-xs font-semibold uppercase text-muted-foreground">Source refs</p>
        <div className="mt-2 space-y-2">
          {episode.refs.length > 0 ? (
            episode.refs.map((ref) => (
              <a
                key={ref.id}
                href={sourceRefHref(ref)}
                target={sourceRefTarget(ref)}
                rel={sourceRefTarget(ref) ? "noreferrer" : undefined}
                className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{ref.refKind}</span>
                  <span className="block break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {ref.refValue}
                  </span>
                  {ref.queryHint ? (
                    <span className="block break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {ref.queryHint}
                    </span>
                  ) : null}
                </span>
                <ExternalLink size={16} className="mt-1 shrink-0" />
              </a>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No source refs</p>
          )}
        </div>
      </div>
    </section>
  );
}

type CreateEpisodeCardProps = {
  form: EpisodeFormState;
  onFieldChange: <K extends keyof EpisodeFormState>(key: K, value: EpisodeFormState[K]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  hasRequiredForm: boolean;
  isPending: boolean;
  error: unknown;
};

function CreateEpisodeCard({
  form,
  onFieldChange,
  onSubmit,
  hasRequiredForm,
  isPending,
  error,
}: CreateEpisodeCardProps) {
  return (
    <form className="space-y-4 p-5" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Label htmlFor="episode-title">Episode title</Label>
        <Input
          id="episode-title"
          value={form.title}
          onChange={(event) => onFieldChange("title", event.target.value)}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="episode-source-kind">Origin type</Label>
          <Select
            id="episode-source-kind"
            value={form.sourceKind}
            onChange={(event) =>
              onFieldChange("sourceKind", event.target.value as EpisodeSourceKind)
            }
          >
            {sourceKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="episode-source-key">Origin key</Label>
          <Input
            id="episode-source-key"
            value={form.sourceKey}
            onChange={(event) => onFieldChange("sourceKey", event.target.value)}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="episode-summary">Episode summary</Label>
        <Textarea
          id="episode-summary"
          rows={4}
          value={form.summary}
          onChange={(event) => onFieldChange("summary", event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="episode-takeaway">Reusable takeaway</Label>
        <Textarea
          id="episode-takeaway"
          rows={4}
          value={form.takeaway}
          onChange={(event) => onFieldChange("takeaway", event.target.value)}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="episode-result-kind">Result kind</Label>
          <Select
            id="episode-result-kind"
            value={form.outcomeKind}
            onChange={(event) =>
              onFieldChange("outcomeKind", event.target.value as EpisodeOutcomeKind)
            }
          >
            {(["unknown", "success", "failure", "mixed"] as EpisodeOutcomeKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="episode-importance">Importance</Label>
          <Input
            id="episode-importance"
            type="number"
            min={0}
            max={100}
            value={form.importance}
            onChange={(event) => onFieldChange("importance", Number(event.target.value))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="episode-confidence">Confidence</Label>
          <Input
            id="episode-confidence"
            type="number"
            min={0}
            max={100}
            value={form.confidence}
            onChange={(event) => onFieldChange("confidence", Number(event.target.value))}
          />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="episode-card-status">Card state</Label>
          <Select
            id="episode-card-status"
            value={form.status}
            onChange={(event) => onFieldChange("status", event.target.value as EpisodeCardStatus)}
          >
            {(["active", "draft", "deprecated"] as EpisodeCardStatus[]).map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="episode-domains">Domains</Label>
          <Input
            id="episode-domains"
            value={form.domainsCsv}
            onChange={(event) => onFieldChange("domainsCsv", event.target.value)}
            placeholder="episodic-memory, admin-ui"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="episode-technologies">Technologies</Label>
          <Input
            id="episode-technologies"
            value={form.technologiesCsv}
            onChange={(event) => onFieldChange("technologiesCsv", event.target.value)}
            placeholder="typescript, react"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="episode-change-types">Change types</Label>
          <Input
            id="episode-change-types"
            value={form.changeTypesCsv}
            onChange={(event) => onFieldChange("changeTypesCsv", event.target.value)}
            placeholder="ui, api"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="episode-tools">Tools</Label>
          <Input
            id="episode-tools"
            value={form.toolsCsv}
            onChange={(event) => onFieldChange("toolsCsv", event.target.value)}
            placeholder="context_compile"
          />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-[150px_1fr]">
        <div className="space-y-2">
          <Label htmlFor="episode-default-ref-kind">Default ref kind</Label>
          <Select
            id="episode-default-ref-kind"
            value={form.refKind}
            onChange={(event) => onFieldChange("refKind", event.target.value as EpisodeRefKind)}
          >
            {refKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="episode-source-refs">Source refs</Label>
          <Textarea
            id="episode-source-refs"
            value={form.refsText}
            onChange={(event) => onFieldChange("refsText", event.target.value)}
            placeholder="one source ref per line, or kind:value"
            rows={4}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="episode-query-hint">Source query hint</Label>
        <Input
          id="episode-query-hint"
          value={form.queryHint}
          onChange={(event) => onFieldChange("queryHint", event.target.value)}
          placeholder="short phrase to reopen the source context"
        />
      </div>
      {error ? <p className="text-sm text-destructive">{String(error)}</p> : null}
      {!hasRequiredForm ? (
        <p className="text-xs text-muted-foreground">
          Title, origin key, summary, takeaway, and at least one source ref are required.
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={!hasRequiredForm || isPending}>
          <Plus size={16} />
          Register
        </Button>
      </div>
    </form>
  );
}

function EpisodeDrawer({
  episode,
  isLoading,
  onClose,
}: {
  episode: EpisodeCard | undefined;
  isLoading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/25" role="presentation">
      <button
        type="button"
        aria-label="Close episode details backdrop"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <aside
        aria-label="Episode details"
        className="relative z-10 h-full w-full max-w-3xl overflow-auto border-l bg-background p-4 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Episode details
            </p>
            <h2 className="mt-1 text-lg font-semibold">Selected Episode</h2>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading episode...</p>
        ) : episode ? (
          <EpisodeDetail episode={episode} />
        ) : (
          <p className="text-sm text-muted-foreground">Episode not found.</p>
        )}
      </aside>
    </div>
  );
}

export function EpisodesPage() {
  const queryClient = useQueryClient();
  const tz = useTimezone();
  const [queryText, setQueryText] = useState("");
  const [statusFilter, setStatusFilter] = useState<EpisodeStatusFilter>("active_draft");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [form, setForm] = useState<EpisodeFormState>(() => emptyForm());
  const [sorting, setSorting] = useState<SortingState>([{ id: "createdAt", desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });

  const resetToFirstPage = useCallback(() => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  }, []);

  const formatDateTime = useCallback(
    (value: string | Date | null | undefined): string => tzFormatDateTime(value, tz),
    [tz],
  );

  const episodesQuery = useQuery({
    queryKey: ["episodes", { queryText, statusFilter }],
    queryFn: () =>
      fetchEpisodes({
        query: queryText || undefined,
        status: statusFilter === "active_draft" ? undefined : statusFilter,
        includeDraft: statusFilter === "active_draft",
        limit: 100,
      }),
  });

  const selectedEpisodeQuery = useQuery({
    queryKey: ["episode", selectedId],
    queryFn: () => fetchEpisode(selectedId ?? ""),
    enabled: Boolean(selectedId),
  });

  const createMutation = useMutation({
    mutationFn: createEpisode,
    onSuccess: (episode) => {
      setSelectedId(episode.id);
      setForm(emptyForm());
      setIsCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["episodes"] });
      queryClient.setQueryData(["episode", episode.id], episode);
    },
  });

  const items = episodesQuery.data ?? [];
  const selectedEpisode =
    selectedEpisodeQuery.data ?? items.find((episode) => episode.id === selectedId);
  const parsedRefs = useMemo(() => parseSourceRefs(form), [form]);
  const hasRequiredForm = Boolean(
    form.title.trim() &&
      form.sourceKey.trim() &&
      form.summary.trim() &&
      form.takeaway.trim() &&
      parsedRefs.length > 0,
  );
  const stats = useMemo(
    () => ({
      total: items.length,
      withRefs: items.filter((item) => item.refs.length > 0).length,
    }),
    [items],
  );

  function updateField<K extends keyof EpisodeFormState>(key: K, value: EpisodeFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openCreate() {
    setForm(emptyForm());
    setIsCreateOpen(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(toCreateInput(form));
  }

  const columns = useMemo<ColumnDef<EpisodeCard>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Episode",
        cell: ({ row }) => {
          const episode = row.original;
          return (
            <div className="min-w-0 space-y-1">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedId(episode.id);
                }}
                className="text-left text-xs font-semibold text-blue-600 transition-colors hover:text-blue-700 hover:underline"
              >
                {episode.title}
              </button>
              <p className="break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                {textPreview(episode.situation, 130)}
              </p>
            </div>
          );
        },
      },
      {
        id: "source",
        accessorFn: (episode) => `${episode.sourceKind}:${episode.sourceKey}`,
        header: "Source",
        cell: ({ row }) => {
          const episode = row.original;
          return (
            <div className="min-w-0 space-y-1">
              <Badge variant="outline" className="text-[10px]">
                {episode.sourceKind}
              </Badge>
              <p className="break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                {episode.sourceKey}
              </p>
            </div>
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge variant={statusVariant(row.original.status)} className="text-[10px]">
            {row.original.status}
          </Badge>
        ),
      },
      {
        id: "sourceRefs",
        accessorFn: (episode) => episode.refs.length,
        header: "Refs",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.refs.length}
          </span>
        ),
      },
      {
        accessorKey: "outcomeKind",
        header: "Outcome",
        cell: ({ row }) => (
          <Badge variant="outline" className="text-[10px]">
            {row.original.outcomeKind}
          </Badge>
        ),
      },
      {
        id: "technologies",
        accessorFn: (episode) => episode.technologies.join(" "),
        header: "Tech",
        cell: ({ row }) => <FacetBadges items={row.original.technologies} limit={2} />,
      },
      {
        id: "domains",
        accessorFn: (episode) => episode.domains.join(" "),
        header: "Domain",
        cell: ({ row }) => <FacetBadges items={row.original.domains} limit={2} />,
      },
      {
        id: "changeTypes",
        accessorFn: (episode) => episode.changeTypes.join(" "),
        header: "Change",
        cell: ({ row }) => <FacetBadges items={row.original.changeTypes} limit={2} />,
      },
      {
        id: "quality",
        accessorFn: (episode) => episode.importance + episode.confidence,
        header: "Quality",
        cell: ({ row }) => (
          <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
            <div>I:{row.original.importance}</div>
            <div>C:{row.original.confidence}</div>
          </div>
        ),
      },
      {
        id: "uses",
        accessorFn: (episode) => episode.compileUseCount + episode.decisionUseCount,
        header: "Uses",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            C:{row.original.compileUseCount} / D:{row.original.decisionUseCount}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-[11px] text-muted-foreground">
            {formatDateTime(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [formatDateTime],
  );

  const table = useReactTable({
    data: items,
    columns,
    state: {
      sorting,
      pagination,
    },
    onSortingChange: (updater) => {
      setSorting((current) => (typeof updater === "function" ? updater(current) : updater));
      resetToFirstPage();
    },
    onPaginationChange: setPagination,
    enableMultiSort: false,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const total = items.length;
  const currentPage = pagination.pageIndex + 1;
  const totalPages = table.getPageCount();
  const displayTotalPages = Math.max(1, totalPages);
  const pageRows = table.getRowModel().rows;
  const pageStart = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min(pagination.pageIndex * pagination.pageSize + pageRows.length, total);

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden bg-background">
      <Card className="flex flex-1 flex-col overflow-hidden rounded-none border-0 py-0 shadow-none">
        <CardHeader className="border-b bg-muted/20 px-4 py-2">
          <div className="grid grid-cols-1 items-center gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto]">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search episodes"
                value={queryText}
                className="h-9 pl-9"
                onChange={(event) => {
                  setQueryText(event.target.value);
                  resetToFirstPage();
                }}
              />
            </div>
            <Select
              aria-label="episode-status-filter"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as EpisodeStatusFilter);
                setSelectedId(null);
                resetToFirstPage();
              }}
            >
              <option value="active_draft">active + draft</option>
              <option value="active">active</option>
              <option value="draft">draft</option>
              <option value="deprecated">deprecated</option>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 justify-self-end"
              onClick={() => episodesQuery.refetch()}
              disabled={episodesQuery.isFetching}
            >
              <RefreshCw size={14} className={episodesQuery.isFetching ? "animate-spin" : ""} />
              Refresh
            </Button>
            <Button type="button" size="sm" className="h-9 gap-2" onClick={openCreate}>
              <Plus size={14} />
              New
            </Button>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
            <Badge variant="outline">{stats.total} cards</Badge>
            <Badge variant="secondary">{stats.withRefs} with refs</Badge>
            <Badge variant="outline">limit 100</Badge>
          </div>
        </CardHeader>

        <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
          {episodesQuery.isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading episodes...
            </div>
          ) : null}
          {!episodesQuery.isLoading && episodesQuery.isError ? (
            <div className="flex h-full items-center justify-center text-sm text-destructive">
              Failed to load episodes.
            </div>
          ) : null}
          {!episodesQuery.isLoading && !episodesQuery.isError && items.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No episode cards found.
            </div>
          ) : null}
          {!episodesQuery.isLoading && !episodesQuery.isError && items.length > 0 ? (
            <>
              <div className="shrink-0 border-b bg-background/95 shadow-sm">
                <table className="w-full table-fixed caption-bottom text-sm">
                  <EpisodeColumnGroup />
                  <TableHeader>
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                          <AdminSortableTableHead
                            key={header.id}
                            header={header}
                            className={tableHeadClass}
                          />
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                </table>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full table-fixed caption-bottom text-sm">
                  <EpisodeColumnGroup />
                  <TableBody>
                    {pageRows.map((row) => {
                      const episode = row.original;
                      return (
                        <TableRow
                          key={episode.id}
                          className={cn(
                            "cursor-pointer hover:bg-muted/30",
                            selectedId === episode.id ? "bg-muted/50" : undefined,
                          )}
                          onClick={() => setSelectedId(episode.id)}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id} className={tableCellClass}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        <AdminPaginationFooter
          keyPrefix="episode"
          currentPage={currentPage}
          totalPages={totalPages}
          canPreviousPage={table.getCanPreviousPage()}
          canNextPage={table.getCanNextPage()}
          onPreviousPage={() => table.previousPage()}
          onNextPage={() => table.nextPage()}
          onPageSelect={(pageNumber) => table.setPageIndex(pageNumber - 1)}
          disabled={episodesQuery.isFetching}
          summaryItems={[
            `Showing ${pageStart} to ${pageEnd} of ${total} episodes | Page ${currentPage} / ${displayTotalPages}`,
            `with refs ${stats.withRefs}`,
          ]}
        />
        {selectedId ? (
          <EpisodeDrawer
            episode={selectedEpisode}
            isLoading={selectedEpisodeQuery.isLoading}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </Card>

      <AdminModalShell
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title={
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Create Episode Card
            </p>
            <h2 className="text-lg font-semibold">New Episode</h2>
          </div>
        }
        ariaLabel="Create Episode Card"
        panelClassName="max-w-4xl"
        bodyClassName="max-h-[calc(85vh-73px)]"
      >
        <CreateEpisodeCard
          form={form}
          onFieldChange={updateField}
          onSubmit={submit}
          hasRequiredForm={hasRequiredForm}
          isPending={createMutation.isPending}
          error={createMutation.error}
        />
      </AdminModalShell>
    </div>
  );
}
