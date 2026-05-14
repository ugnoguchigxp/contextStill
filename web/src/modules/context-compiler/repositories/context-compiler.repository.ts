export type CompileIntent = "plan" | "edit" | "debug" | "review" | "finish";
export type CompileMode =
  | "task_context"
  | "review_context"
  | "debug_context"
  | "architecture_context"
  | "skill_context"
  | "learning_context";

export type CompileRequest = {
  goal: string;
  intent: CompileIntent;
  retrievalMode?: CompileMode;
  includeTrial?: boolean;
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

export async function compilePack(input: CompileRequest): Promise<Record<string, unknown>> {
  const response = await fetch("/api/context/compile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Compile failed: ${response.status}`);
  }
  const json = (await response.json()) as { pack: Record<string, unknown> };
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
