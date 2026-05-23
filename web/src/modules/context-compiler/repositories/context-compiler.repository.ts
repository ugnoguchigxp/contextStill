export type CompileRunSource = "ui" | "mcp" | "cli" | "unknown";
export type CompileRunKnowledgeVerdict = "used" | "not_used" | "off_topic" | "wrong";

export type CompileRequest = {
  goal: string;
  changeTypes?: string[];
  technologies?: string[];
  domains?: string[];
};

export type CompileRunSummary = {
  id: string;
  goal: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  durationMs: number;
  source: CompileRunSource;
  createdAt: string;
};

export type CompilePackItem = {
  id: string;
  itemKind: string;
  title: string;
  content: string;
  score: number;
  rankingReason: string;
  sourceRefs: string[];
};

export type CompilePack = {
  runId: string;
  goal: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  minimalTasks: string[];
  rules: CompilePackItem[];
  procedures: CompilePackItem[];
  warnings: string[];
  sourceRefs: string[];
  diagnostics: {
    degradedReasons: string[];
    retrievalStats: Record<string, unknown>;
    inputFacets?: {
      requested?: Record<string, string[]>;
      matched?: Record<string, string[]>;
      unknown?: Record<string, string[]>;
    };
  };
};

export type CompileResponse = {
  pack: CompilePack;
  markdown: string;
};

export type CompileRunSelectedItem = {
  itemKind: string;
  itemId: string;
  section: string;
  score: number;
  rankingReason: string;
  sourceRefs: string[];
};

export type CompileRunKnowledgeFeedback = {
  id: string;
  runId: string;
  knowledgeId: string;
  verdict: CompileRunKnowledgeVerdict;
  actor: "agent" | "user" | "system";
  reason?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompileRunKnowledgeSignal = {
  knowledgeId: string;
  rawId: string;
  itemKind: "rule" | "procedure";
  section: "rules" | "procedures";
  title: string;
  score: number;
  rankingReason: string;
  autoVerdict: CompileRunKnowledgeVerdict | null;
  autoActor: "agent" | "user" | "system" | null;
  autoReason: string | null;
  effectiveVerdict: CompileRunKnowledgeVerdict | null;
  effectiveActor: "agent" | "user" | "system" | null;
  effectiveReason: string | null;
  hasUserOverride: boolean;
  updatedAt: string | null;
};

export type CompileRunDetail = {
  run: CompileRunSummary & {
    tokenBudget: number;
    input: Partial<CompileRequest> & Record<string, unknown>;
  };
  pack: CompilePack | null;
  outputMarkdown?: string | null;
  selectedItems: CompileRunSelectedItem[];
  knowledgeFeedback: CompileRunKnowledgeFeedback[];
  knowledgeSignals: CompileRunKnowledgeSignal[];
  snapshotAvailable: boolean;
};

export type CompileRunKnowledgeFeedbackWriteItem = {
  knowledgeId: string;
  verdict: CompileRunKnowledgeVerdict;
  reason?: string;
};

export type CompileRunKnowledgeFeedbackResult = {
  savedCount: number;
  updatedCount: number;
  queueCreatedCount: number;
  queueDismissedCount: number;
  affectedKnowledgeIds: string[];
};

export async function compilePack(input: CompileRequest): Promise<CompileResponse> {
  const response = await fetch("/api/context/compile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Compile failed: ${response.status}`);
  }
  return (await response.json()) as CompileResponse;
}

export async function fetchRecentRuns(limit = 20): Promise<CompileRunSummary[]> {
  const response = await fetch(`/api/context/runs?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`Fetch runs failed: ${response.status}`);
  }
  const json = (await response.json()) as { runs: CompileRunSummary[] };
  return json.runs;
}

export async function fetchRunDetail(runId: string): Promise<CompileRunDetail> {
  const response = await fetch(`/api/context/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    throw new Error(`Fetch run detail failed: ${response.status}`);
  }
  const json = (await response.json()) as { detail: CompileRunDetail };
  return json.detail;
}

export async function submitRunKnowledgeFeedback(
  runId: string,
  items: CompileRunKnowledgeFeedbackWriteItem[],
): Promise<CompileRunKnowledgeFeedbackResult> {
  const response = await fetch(
    `/api/context/runs/${encodeURIComponent(runId)}/knowledge-feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    },
  );
  if (!response.ok) {
    throw new Error(`Save knowledge feedback failed: ${response.status}`);
  }
  const json = (await response.json()) as { feedback: CompileRunKnowledgeFeedbackResult };
  return json.feedback;
}
