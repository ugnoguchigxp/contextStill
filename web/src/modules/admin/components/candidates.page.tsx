import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchCandidateItems,
  type CandidateListItem,
  type CandidateOutcome,
} from "../repositories/admin.repository";

const outcomeOptions: Array<"all" | CandidateOutcome> = [
  "all",
  "stored",
  "ready_not_finalized",
  "rejected",
  "retryable",
  "candidate_only",
  "target_pending",
];

const tableHeadClass = "px-3 whitespace-normal break-words [overflow-wrap:anywhere]";
const tableCellClass = "px-3 py-3 align-top whitespace-normal break-words [overflow-wrap:anywhere]";
const compactBadgeClass = "text-[10px] whitespace-normal break-words [overflow-wrap:anywhere]";

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ja-JP", { hour12: false });
}

function toPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function coverageBadge(status: string): "success" | "warning" | "destructive" | "secondary" {
  if (status === "knowledge_ready") return "success";
  if (status === "duplicate" || status === "near_duplicate" || status === "insufficient") {
    return "warning";
  }
  if (status === "tool_failed" || status === "provider_failed" || status === "parse_failed") {
    return "destructive";
  }
  return "secondary";
}

function outcomeBadge(
  outcome: CandidateOutcome,
): "success" | "warning" | "destructive" | "secondary" {
  if (outcome === "stored") return "success";
  if (outcome === "ready_not_finalized" || outcome === "target_pending") return "warning";
  if (outcome === "rejected" || outcome === "retryable") return "destructive";
  return "secondary";
}

function diffSignals(item: CandidateListItem): string[] {
  const summary =
    item.diff.originalToKnowledge?.summary ?? item.diff.originalToCover?.summary ?? [];
  return summary.slice(0, 3);
}

function textPreview(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function CandidateDetailPane({
  sectionTitle,
  candidateTitle,
  candidateBody,
  type,
  importance,
  confidence,
}: {
  sectionTitle: string;
  candidateTitle: string | null;
  candidateBody: string | null;
  type?: string | null;
  importance?: number | null;
  confidence?: number | null;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2 min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {sectionTitle}
      </p>
      <p className="text-xs font-semibold break-words [overflow-wrap:anywhere]">
        {candidateTitle ? textPreview(candidateTitle, 120) : "-"}
      </p>
      <p className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
        {candidateBody ? textPreview(candidateBody, 180) : "-"}
      </p>
      <div className="text-[11px] text-muted-foreground break-words [overflow-wrap:anywhere]">
        type: {type ?? "-"} | importance: {importance ?? "-"} | confidence: {confidence ?? "-"}
      </div>
    </div>
  );
}

export function CandidatesPage() {
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [queryText, setQueryText] = useState("");
  const [targetKind, setTargetKind] = useState<"all" | "wiki_file" | "vibe_memory">("all");
  const [outcome, setOutcome] = useState<"all" | CandidateOutcome>("all");
  const [hasKnowledge, setHasKnowledge] = useState<"all" | "yes" | "no">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const candidatesQuery = useQuery({
    queryKey: ["candidates", { page, limit, queryText, targetKind, outcome, hasKnowledge }],
    queryFn: () =>
      fetchCandidateItems({
        page,
        limit,
        query: queryText || undefined,
        targetKind,
        outcome,
        hasKnowledge,
      }),
  });

  const items = candidatesQuery.data?.items ?? [];
  const stats = candidatesQuery.data?.stats;
  const totalPages = candidatesQuery.data?.totalPages ?? 0;
  const hasPrev = page > 1;
  const hasNext = totalPages > 0 && page < totalPages;

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden bg-background">
      <Card className="flex flex-1 flex-col overflow-hidden rounded-none border-0 shadow-none gap-0 py-0">
        <CardHeader className="border-b bg-muted/20 px-4 py-2">
          <div className="grid grid-cols-1 items-center gap-2 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search target / candidate / knowledge"
                value={queryText}
                className="h-9 pl-9"
                onChange={(event) => {
                  setQueryText(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Select
              aria-label="target-kind"
              value={targetKind}
              onChange={(event) => {
                setTargetKind(event.target.value as "all" | "wiki_file" | "vibe_memory");
                setPage(1);
              }}
            >
              <option value="all">all target kinds</option>
              <option value="wiki_file">wiki_file</option>
              <option value="vibe_memory">vibe_memory</option>
            </Select>
            <Select
              aria-label="outcome"
              value={outcome}
              onChange={(event) => {
                setOutcome(event.target.value as "all" | CandidateOutcome);
                setPage(1);
              }}
            >
              {outcomeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <Select
              aria-label="has-knowledge"
              value={hasKnowledge}
              onChange={(event) => {
                setHasKnowledge(event.target.value as "all" | "yes" | "no");
                setPage(1);
              }}
            >
              <option value="all">all knowledge states</option>
              <option value="yes">knowledge yes</option>
              <option value="no">knowledge no</option>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 justify-self-end"
              onClick={() => candidatesQuery.refetch()}
              disabled={candidatesQuery.isFetching}
            >
              <RefreshCw size={14} className={candidatesQuery.isFetching ? "animate-spin" : ""} />
              Refresh
            </Button>
          </div>
        </CardHeader>

        <div className="min-w-0 flex-1 overflow-auto">
          <Table className="table-fixed">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[25%]" />
              <col className="w-[14%]" />
              <col className="w-[14%]" />
              <col className="w-[8%]" />
              <col className="w-[13%]" />
              <col className="w-[8%]" />
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-background/95 border-b shadow-sm">
              <TableRow>
                <TableHead className={tableHeadClass}>Target</TableHead>
                <TableHead className={tableHeadClass}>Candidate</TableHead>
                <TableHead className={tableHeadClass}>Coverage</TableHead>
                <TableHead className={tableHeadClass}>Knowledge</TableHead>
                <TableHead className={tableHeadClass}>Quality</TableHead>
                <TableHead className={tableHeadClass}>Diff</TableHead>
                <TableHead className={tableHeadClass}>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidatesQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                    Loading candidates...
                  </TableCell>
                </TableRow>
              ) : null}
              {!candidatesQuery.isLoading && candidatesQuery.isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-destructive">
                    Failed to load candidates.
                  </TableCell>
                </TableRow>
              ) : null}
              {!candidatesQuery.isLoading && !candidatesQuery.isError && items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                    No candidates found.
                  </TableCell>
                </TableRow>
              ) : null}
              {items.map((item) => (
                <Fragment key={item.id}>
                  <TableRow key={item.id} className="cursor-pointer hover:bg-muted/30">
                    <TableCell
                      className={tableCellClass}
                      onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                          <Badge variant="outline" className={compactBadgeClass}>
                            {item.targetKind}
                          </Badge>
                          <Badge variant={outcomeBadge(item.outcome)} className={compactBadgeClass}>
                            {item.outcome}
                          </Badge>
                        </div>
                        <p className="text-xs font-medium break-words [overflow-wrap:anywhere]">
                          {item.targetKey}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          idx: {item.candidateIndex}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell
                      className={tableCellClass}
                      onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                    >
                      <p className="text-xs font-semibold break-words [overflow-wrap:anywhere]">
                        {item.original.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground break-words [overflow-wrap:anywhere]">
                        {textPreview(item.original.body, 100)}
                      </p>
                    </TableCell>
                    <TableCell
                      className={tableCellClass}
                      onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                    >
                      {item.cover ? (
                        <div className="min-w-0 space-y-1">
                          <Badge
                            variant={coverageBadge(item.cover.status)}
                            className={compactBadgeClass}
                          >
                            {item.cover.status}
                          </Badge>
                          <p className="text-[11px] text-muted-foreground">
                            stage: {item.cover.stage}
                          </p>
                          <p className="text-[11px] text-muted-foreground break-words [overflow-wrap:anywhere]">
                            {item.cover.reason ?? "-"}
                          </p>
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">no cover result</span>
                      )}
                    </TableCell>
                    <TableCell className={tableCellClass}>
                      {item.knowledge ? (
                        <div className="min-w-0 space-y-1">
                          <Badge variant="success" className={compactBadgeClass}>
                            {item.knowledge.status}
                          </Badge>
                          <Link
                            to="/knowledge"
                            className="block text-[11px] text-blue-600 hover:underline break-words [overflow-wrap:anywhere]"
                          >
                            {item.knowledge.id}
                          </Link>
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">not stored</span>
                      )}
                    </TableCell>
                    <TableCell className={tableCellClass}>
                      <p className="text-[11px] text-muted-foreground">
                        I: {item.cover?.importance ?? item.knowledge?.importance ?? "-"}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        C: {item.cover?.confidence ?? item.knowledge?.confidence ?? "-"}
                      </p>
                    </TableCell>
                    <TableCell className={tableCellClass}>
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {diffSignals(item).map((label) => (
                          <Badge
                            key={`${item.id}-${label}`}
                            variant="outline"
                            className={compactBadgeClass}
                          >
                            {label}
                          </Badge>
                        ))}
                        {item.diff.originalToKnowledge ? (
                          <Badge variant="secondary" className={compactBadgeClass}>
                            sim {toPercent(item.diff.originalToKnowledge.bodySimilarity)}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className={`${tableCellClass} text-[11px] text-muted-foreground`}>
                      {formatDate(item.latestUpdatedAt)}
                    </TableCell>
                  </TableRow>
                  {expandedId === item.id ? (
                    <TableRow className="bg-muted/20">
                      <TableCell
                        colSpan={7}
                        className="px-3 py-4 whitespace-normal break-words [overflow-wrap:anywhere]"
                      >
                        <div className="grid min-w-0 gap-3 lg:grid-cols-3">
                          <CandidateDetailPane
                            sectionTitle="Original Candidate"
                            candidateTitle={item.original.title}
                            candidateBody={item.original.body}
                            type={null}
                          />
                          <CandidateDetailPane
                            sectionTitle="Covered Candidate"
                            candidateTitle={item.cover?.title ?? null}
                            candidateBody={item.cover?.body ?? null}
                            type={item.cover?.type ?? null}
                            importance={item.cover?.importance ?? null}
                            confidence={item.cover?.confidence ?? null}
                          />
                          <CandidateDetailPane
                            sectionTitle="Final Knowledge"
                            candidateTitle={item.knowledge?.title ?? null}
                            candidateBody={item.knowledge?.body ?? null}
                            type={item.knowledge?.type ?? null}
                            importance={item.knowledge?.importance ?? null}
                            confidence={item.knowledge?.confidence ?? null}
                          />
                        </div>
                        <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground lg:grid-cols-2">
                          <div className="min-w-0 rounded-lg border bg-background px-3 py-2 break-words [overflow-wrap:anywhere]">
                            <p>targetStateId: {item.targetStateId}</p>
                            <p>findCandidateResultId: {item.id}</p>
                            <p>coverEvidenceResultId: {item.id}</p>
                            <p>knowledgeId: {item.knowledge?.id ?? "-"}</p>
                          </div>
                          <div className="min-w-0 rounded-lg border bg-background px-3 py-2 break-words [overflow-wrap:anywhere]">
                            <p>sourceUri: {item.sourceUri}</p>
                            <p>finalizeSourceUri: {item.finalizeSourceUri}</p>
                            <p>references: {item.cover?.referencesCount ?? 0}</p>
                            <p>duplicateRefs: {item.cover?.duplicateRefsCount ?? 0}</p>
                            <p>toolEvents: {item.cover?.toolEventsCount ?? 0}</p>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="border-t bg-muted/10 px-4 py-1.5 flex flex-wrap items-center justify-between gap-3 text-[11px] leading-4">
          <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>
              Page {page} / {Math.max(1, totalPages)}
            </span>
            <span>
              total {stats?.total ?? 0} | stored {stats?.stored ?? 0} | ready{" "}
              {stats?.readyNotFinalized ?? 0} | rejected {stats?.rejected ?? 0} | retryable{" "}
              {stats?.retryable ?? 0} | pending {stats?.targetPending ?? 0}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={!hasPrev}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={!hasNext}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
