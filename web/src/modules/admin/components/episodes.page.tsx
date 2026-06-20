import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime as tzFormatDateTime, useTimezone } from "@/lib/timezone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus, RefreshCw, Search } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import {
  type EpisodeCard,
  type EpisodeCardCreateInput,
  type EpisodeCardStatus,
  type EpisodeEvidenceStatus,
  type EpisodeOutcomeKind,
  type EpisodeRef,
  type EpisodeRefInput,
  type EpisodeRefKind,
  type EpisodeSourceKind,
  createEpisode,
  fetchEpisode,
  fetchEpisodes,
} from "../repositories/admin.repository";

type EpisodeFormState = {
  title: string;
  sourceKind: EpisodeSourceKind;
  sourceKey: string;
  summary: string;
  takeaway: string;
  outcomeKind: EpisodeOutcomeKind;
  evidenceStatus: EpisodeEvidenceStatus;
  status: EpisodeCardStatus;
  domainsCsv: string;
  technologiesCsv: string;
  changeTypesCsv: string;
  toolsCsv: string;
  refKind: EpisodeRefKind;
  refsText: string;
  queryHint: string;
};

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
  evidenceStatus: "unverified",
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

function csv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEvidenceRefs(state: EpisodeFormState): EpisodeRefInput[] {
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
    evidenceStatus: state.evidenceStatus,
    status: state.status,
    domains: csv(state.domainsCsv),
    technologies: csv(state.technologiesCsv),
    changeTypes: csv(state.changeTypesCsv),
    tools: csv(state.toolsCsv),
    metadata: { source: "admin_ui_manual", uiSchemaVersion: "episode-card.v2" },
    refs: parseEvidenceRefs(state),
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

function evidenceHref(ref: EpisodeRef): string {
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

function evidenceTarget(ref: EpisodeRef): "_blank" | undefined {
  return ref.refKind === "file" && /^https?:\/\//i.test(ref.refValue) ? "_blank" : undefined;
}

function statusVariant(value: EpisodeCardStatus) {
  if (value === "active") return "success";
  if (value === "draft") return "warning";
  return "secondary";
}

function evidenceVariant(value: EpisodeEvidenceStatus) {
  if (value === "verified") return "success";
  if (value === "partial") return "warning";
  return "outline";
}

function EpisodeDetail({ episode }: { episode: EpisodeCard }) {
  const tz = useTimezone();
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
        <Badge variant={evidenceVariant(episode.evidenceStatus)}>{episode.evidenceStatus}</Badge>
        <Badge variant="outline">{episode.outcomeKind}</Badge>
        <Badge variant="secondary">confidence {episode.confidence}</Badge>
      </div>
      <div className="space-y-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
            <p className="whitespace-pre-wrap text-sm leading-6">{value || "-"}</p>
          </div>
        ))}
        {auxiliaryFacts.map(([label, value]) => (
          <div key={label}>
            <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
            <p className="whitespace-pre-wrap text-sm leading-6">{value}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Source</p>
          <p className="break-words text-sm">
            {episode.sourceKind}: {episode.sourceKey}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Created</p>
          <p className="text-sm">{tzFormatDateTime(episode.createdAt, tz)}</p>
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase text-muted-foreground">Facets</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {[...episode.domains, ...episode.technologies, ...episode.changeTypes, ...episode.tools]
            .slice(0, 24)
            .map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase text-muted-foreground">Evidence</p>
        <div className="mt-2 space-y-2">
          {episode.refs.length > 0 ? (
            episode.refs.map((ref) => (
              <a
                key={ref.id}
                href={evidenceHref(ref)}
                target={evidenceTarget(ref)}
                rel={evidenceTarget(ref) ? "noreferrer" : undefined}
                className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{ref.refKind}</span>
                  <span className="block break-words text-xs text-muted-foreground">
                    {ref.refValue}
                  </span>
                  {ref.queryHint ? (
                    <span className="block break-words text-xs text-muted-foreground">
                      {ref.queryHint}
                    </span>
                  ) : null}
                </span>
                <ExternalLink size={16} className="mt-1 shrink-0" />
              </a>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No evidence refs</p>
          )}
        </div>
      </div>
    </section>
  );
}

export function EpisodesPage() {
  const queryClient = useQueryClient();
  const tz = useTimezone();
  const [queryText, setQueryText] = useState("");
  const [includeDraft, setIncludeDraft] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<EpisodeFormState>(() => emptyForm());

  const episodesQuery = useQuery({
    queryKey: ["episodes", { queryText, includeDraft }],
    queryFn: () =>
      fetchEpisodes({
        query: queryText || undefined,
        includeDraft,
        limit: 80,
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
      queryClient.invalidateQueries({ queryKey: ["episodes"] });
      queryClient.setQueryData(["episode", episode.id], episode);
    },
  });

  const selectedEpisode =
    selectedEpisodeQuery.data ?? episodesQuery.data?.find((e) => e.id === selectedId);
  const items = episodesQuery.data ?? [];
  const hasRequiredForm =
    form.title.trim() &&
    form.sourceKey.trim() &&
    form.summary.trim() &&
    form.takeaway.trim() &&
    parseEvidenceRefs(form).length > 0;

  const stats = useMemo(
    () => ({
      total: items.length,
      verified: items.filter((item) => item.evidenceStatus === "verified").length,
      withRefs: items.filter((item) => item.refs.length > 0).length,
    }),
    [items],
  );

  function updateField<K extends keyof EpisodeFormState>(key: K, value: EpisodeFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(toCreateInput(form));
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">episode cards</Badge>
            <Badge variant="outline">source-backed registration</Badge>
          </div>
          <h1 className="text-2xl font-semibold">Episodes</h1>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge variant="outline">{stats.total} cards</Badge>
          <Badge variant="success">{stats.verified} verified</Badge>
          <Badge variant="secondary">{stats.withRefs} with evidence</Badge>
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[260px] flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="pl-9"
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                placeholder="Search episodes"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeDraft}
                onChange={(event) => setIncludeDraft(event.target.checked)}
              />
              include draft
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => episodesQuery.refetch()}
              disabled={episodesQuery.isFetching}
            >
              <RefreshCw size={16} />
              Refresh
            </Button>
          </div>

          <div className="grid gap-3">
            {items.map((episode) => (
              <button
                key={episode.id}
                type="button"
                className={`rounded-md border p-4 text-left transition hover:bg-muted/50 ${
                  selectedId === episode.id ? "border-primary bg-muted/40" : ""
                }`}
                onClick={() => setSelectedId(episode.id)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant(episode.status)}>{episode.status}</Badge>
                  <Badge variant={evidenceVariant(episode.evidenceStatus)}>
                    {episode.evidenceStatus}
                  </Badge>
                  <Badge variant="outline">{episode.sourceKind}</Badge>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {tzFormatDateTime(episode.createdAt, tz)}
                  </span>
                </div>
                <h2 className="mt-2 break-words text-sm font-semibold">{episode.title}</h2>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {textPreview(episode.situation)}
                </p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {[...episode.domains, ...episode.technologies, ...episode.changeTypes]
                    .slice(0, 8)
                    .map((tag) => (
                      <Badge key={`${episode.id}:${tag}`} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  {episode.refs.length > 0 ? (
                    <Badge variant="secondary">{episode.refs.length} refs</Badge>
                  ) : null}
                </div>
              </button>
            ))}
            {items.length === 0 && !episodesQuery.isLoading ? (
              <div className="rounded-md border p-6 text-sm text-muted-foreground">
                No episode cards found
              </div>
            ) : null}
          </div>
        </section>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Create Episode Card</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={submit}>
                <div className="space-y-2">
                  <Label htmlFor="episode-title">Episode title</Label>
                  <Input
                    id="episode-title"
                    value={form.title}
                    onChange={(event) => updateField("title", event.target.value)}
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="episode-source-kind">Origin type</Label>
                    <Select
                      id="episode-source-kind"
                      value={form.sourceKind}
                      onChange={(event) =>
                        updateField("sourceKind", event.target.value as EpisodeSourceKind)
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
                      onChange={(event) => updateField("sourceKey", event.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="episode-summary">Episode summary</Label>
                  <Textarea
                    id="episode-summary"
                    rows={4}
                    value={form.summary}
                    onChange={(event) => updateField("summary", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="episode-takeaway">Reusable takeaway</Label>
                  <Textarea
                    id="episode-takeaway"
                    rows={4}
                    value={form.takeaway}
                    onChange={(event) => updateField("takeaway", event.target.value)}
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="episode-result-kind">Result kind</Label>
                    <Select
                      id="episode-result-kind"
                      value={form.outcomeKind}
                      onChange={(event) =>
                        updateField("outcomeKind", event.target.value as EpisodeOutcomeKind)
                      }
                    >
                      {(["unknown", "success", "failure", "mixed"] as EpisodeOutcomeKind[]).map(
                        (kind) => (
                          <option key={kind} value={kind}>
                            {kind}
                          </option>
                        ),
                      )}
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="episode-evidence-status">Evidence state</Label>
                    <Select
                      id="episode-evidence-status"
                      value={form.evidenceStatus}
                      onChange={(event) =>
                        updateField("evidenceStatus", event.target.value as EpisodeEvidenceStatus)
                      }
                    >
                      {(["unverified", "partial", "verified"] as EpisodeEvidenceStatus[]).map(
                        (status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ),
                      )}
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="episode-card-status">Card state</Label>
                    <Select
                      id="episode-card-status"
                      value={form.status}
                      onChange={(event) =>
                        updateField("status", event.target.value as EpisodeCardStatus)
                      }
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
                      onChange={(event) => updateField("domainsCsv", event.target.value)}
                      placeholder="episodic-memory, admin-ui"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="episode-technologies">Technologies</Label>
                    <Input
                      id="episode-technologies"
                      value={form.technologiesCsv}
                      onChange={(event) => updateField("technologiesCsv", event.target.value)}
                      placeholder="typescript, react"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="episode-change-types">Change types</Label>
                    <Input
                      id="episode-change-types"
                      value={form.changeTypesCsv}
                      onChange={(event) => updateField("changeTypesCsv", event.target.value)}
                      placeholder="ui, api"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="episode-tools">Tools</Label>
                    <Input
                      id="episode-tools"
                      value={form.toolsCsv}
                      onChange={(event) => updateField("toolsCsv", event.target.value)}
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
                      onChange={(event) =>
                        updateField("refKind", event.target.value as EpisodeRefKind)
                      }
                    >
                      {refKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="episode-evidence-refs">Evidence refs</Label>
                    <Textarea
                      id="episode-evidence-refs"
                      value={form.refsText}
                      onChange={(event) => updateField("refsText", event.target.value)}
                      placeholder="one evidence ref per line, or kind:value"
                      rows={4}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="episode-query-hint">Evidence query hint</Label>
                  <Input
                    id="episode-query-hint"
                    value={form.queryHint}
                    onChange={(event) => updateField("queryHint", event.target.value)}
                    placeholder="short phrase to reopen the source context"
                  />
                </div>
                {createMutation.error ? (
                  <p className="text-sm text-destructive">{String(createMutation.error)}</p>
                ) : null}
                {!hasRequiredForm ? (
                  <p className="text-xs text-muted-foreground">
                    Title, origin key, summary, takeaway, and at least one evidence ref are
                    required.
                  </p>
                ) : null}
                <Button type="submit" disabled={!hasRequiredForm || createMutation.isPending}>
                  <Plus size={16} />
                  Register
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Selected Episode</CardTitle>
            </CardHeader>
            <CardContent>
              {selectedEpisode ? (
                <EpisodeDetail episode={selectedEpisode} />
              ) : (
                <p className="text-sm text-muted-foreground">No episode selected</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
