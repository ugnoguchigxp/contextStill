export type CompileIntent = "plan" | "edit" | "debug" | "review" | "finish";
export type CompileMode =
  | "task_context"
  | "review_context"
  | "debug_context"
  | "architecture_context"
  | "procedure_context"
  | "learning_context";

export type CompileRequest = {
  goal: string;
  intent: CompileIntent;
  retrievalMode?: CompileMode;
  includeDraft?: boolean;
  files?: string[];
};

export type CompileRunSummary = {
  id: string;
  goal: string;
  intent: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  createdAt: string;
};

export type CompilePackItem = {
  id: string;
  itemKind: string;
  title: string;
  content: string;
  score: number;
  rankingReason: string;
};

export type CompilePack = {
  runId: string;
  goal: string;
  intent: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  minimalTasks: string[];
  rules: CompilePackItem[];
  procedures: CompilePackItem[];
  codeContext: CompilePackItem[];
  warnings: string[];
  diagnostics: {
    degradedReasons: string[];
    retrievalStats: Record<string, unknown>;
  };
};

export async function compilePack(input: CompileRequest): Promise<CompilePack> {
  const response = await fetch("/api/context/compile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Compile failed: ${response.status}`);
  }
  const json = (await response.json()) as { pack: CompilePack };
  return json.pack;
}

export async function fetchRecentRuns(limit = 20): Promise<CompileRunSummary[]> {
  const response = await fetch(`/api/context/runs?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`Fetch runs failed: ${response.status}`);
  }
  const json = (await response.json()) as { runs: CompileRunSummary[] };
  return json.runs;
}
