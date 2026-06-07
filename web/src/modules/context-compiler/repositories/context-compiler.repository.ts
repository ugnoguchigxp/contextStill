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
  evalSummary?: {
    count: number;
    latestAvg: number | null;
    averageAvg: number | null;
    latestOutcome: "useful" | "partial" | "misleading" | "unused" | null;
    latestEvaluatedAt: string | null;
  };
  createdAt: string;
};

export type CompilePackItem = {
  id: string;
  itemId: string;
  itemKind: string;
  title: string;
  content: string;
  score: number;
  rankingReason: string;
  sourceRefs: string[];
  changeTypes?: string[];
  technologies?: string[];
  domains?: string[];
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
  evaluations: Array<{
    id: string;
    runId: string;
    sessionId: string | null;
    avg: number;
    outcome: "useful" | "partial" | "misleading" | "unused";
    title: string | null;
    body: string;
    source: "mcp" | "ui" | "system" | "import";
    relevance: number | null;
    actionability: number | null;
    coverage: number | null;
    clarity: number | null;
    specificity: number | null;
    createdAt: string;
    updatedAt: string;
  }>;
  snapshotAvailable: boolean;
};

export type CompileRunRankingTraceItem = {
  itemKind: "rule" | "procedure";
  itemId: string;
  title: string;
  status: "active" | "draft" | "deprecated";
  textRank: number | null;
  textScore: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  mergedRank: number | null;
  mergedScore: number | null;
  finalRank: number | null;
  finalScore: number | null;
  selected: boolean;
  packed: boolean;
  packPosition: number | null;
  suppressed: boolean;
  suppressionReason: string | null;
  agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
  rankingReason: string | null;
  communityKey: string | null;
  feedback: {
    verdict: CompileRunKnowledgeVerdict | null;
    actor: "agent" | "user" | "system" | null;
    reason: string | null;
    updatedAt: string | null;
  };
  sourceRefs: string[];
};

export type CompileRunRankingTrace = {
  run: {
    id: string;
    goal: string;
    repoPath: string | null;
    retrievalMode: string;
    status: "ok" | "degraded" | "failed";
    input: Record<string, unknown>;
    createdAt: string;
  };
  evalSummary: {
    count: number;
    latestAvg: number | null;
    latestOutcome: "useful" | "partial" | "misleading" | "unused" | null;
  };
  feedbackSummary: {
    used: number;
    notUsed: number;
    offTopic: number;
    wrong: number;
    noSignal: number;
  };
  funnel: {
    textHitCount: number;
    vectorHitCount: number;
    mergedCount: number;
    finalCount: number;
    packedCount: number;
    selectedCount: number;
    suppressedCount: number;
  };
  items: CompileRunRankingTraceItem[];
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

export async function fetchRunRankingTrace(runId: string): Promise<CompileRunRankingTrace> {
  const response = await fetch(`/api/context/runs/${encodeURIComponent(runId)}/ranking-trace`);
  if (!response.ok) {
    throw new Error(`Fetch run ranking trace failed: ${response.status}`);
  }
  const json = (await response.json()) as { trace: CompileRunRankingTrace };
  return json.trace;
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

export async function deprecateKnowledgeItem(knowledgeId: string): Promise<void> {
  const response = await fetch(`/api/knowledge/${encodeURIComponent(knowledgeId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "deprecated" }),
  });
  if (!response.ok) {
    throw new Error(`Deprecate knowledge failed: ${response.status}`);
  }
}
