import { config } from "../../config.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";

export type AgenticCandidate = {
  id: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  title: string;
  content: string;
  score: number;
  sourceRefs: string[];
};

export type AgenticRefineResult = {
  items: AgenticCandidate[];
  agenticUsed: boolean;
  reasoning?: string;
  error?: string;
};

type AzureOpenAiResponse = {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
};

type AgenticLlmOutput = {
  selectedIds: string[];
  reasoning?: string;
};

function buildAzureOpenAiUrl(): string {
  const { azureOpenAiApiBaseUrl, azureOpenAiApiPath, azureOpenAiModel, azureOpenAiApiVersion } =
    config;
  const path = `${azureOpenAiApiPath.replace(/\/+$/, "")}/${encodeURIComponent(
    azureOpenAiModel,
  )}/chat/completions?api-version=${encodeURIComponent(azureOpenAiApiVersion)}`;
  return new URL(path, azureOpenAiApiBaseUrl).toString();
}

function buildSystemPrompt(input: CompileInput, retrievalMode: RetrievalMode): string {
  const lines = [
    "あなたはコーディングエージェントのためのコンテキストコンパイラです。",
    "以下のタスク情報と knowledge 候補リストを受け取り、タスク遂行に**本当に必要な候補だけ**を選別してください。",
    "",
    "## 選別基準",
    "- タスクの goal に直接関係する rule / procedure を優先する。",
    "- 汎用的すぎるルールや、タスクと無関係な候補は除外する。",
    "- deprecated / draft は、タスクに明確に必要な場合のみ含める。",
    "- 選別後の候補は relevance の高い順に並べる。",
    "",
    "## タスク情報",
    `- goal: ${input.goal}`,
    `- intent: ${input.intent}`,
    `- retrievalMode: ${retrievalMode}`,
  ];

  if (input.files && input.files.length > 0) {
    lines.push(`- files: ${input.files.join(", ")}`);
  }
  if (input.technologies && input.technologies.length > 0) {
    lines.push(`- technologies: ${input.technologies.join(", ")}`);
  }
  if (input.changeTypes && input.changeTypes.length > 0) {
    lines.push(`- changeTypes: ${input.changeTypes.join(", ")}`);
  }
  if (input.repoPath) {
    lines.push(`- repoPath: ${input.repoPath}`);
  }

  lines.push(
    "",
    "## 出力形式",
    "JSON のみを返してください。他のテキストは含めないでください。",
    "```json",
    "{",
    '  "selectedIds": ["id1", "id2", ...],',
    '  "reasoning": "選別理由の要約（日本語）"',
    "}",
    "```",
    "",
    "selectedIds は入力候補の id を relevance 順に列挙してください。",
    "該当候補がない場合は空配列を返してください。",
  );

  return lines.join("\n");
}

function buildUserPrompt(candidates: AgenticCandidate[]): string {
  const items = candidates.map((item) => ({
    id: item.id,
    type: item.type,
    status: item.status,
    title: item.title,
    content: item.content.slice(0, 500),
    score: Math.round(item.score * 1000) / 1000,
  }));
  return `## Knowledge 候補一覧\n\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\``;
}

function parseAgenticOutput(raw: string): AgenticLlmOutput | null {
  try {
    // Try direct JSON parse first
    const parsed = JSON.parse(raw) as unknown;
    if (isAgenticOutput(parsed)) return parsed;
  } catch {
    // Try extracting JSON from markdown code block
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim()) as unknown;
        if (isAgenticOutput(parsed)) return parsed;
      } catch {
        // fall through
      }
    }
    // Try finding bare JSON object
    const braceMatch = raw.match(/\{[\s\S]*"selectedIds"[\s\S]*\}/);
    if (braceMatch) {
      try {
        const parsed = JSON.parse(braceMatch[0]) as unknown;
        if (isAgenticOutput(parsed)) return parsed;
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function isAgenticOutput(value: unknown): value is AgenticLlmOutput {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.selectedIds)) return false;
  if (!obj.selectedIds.every((id) => typeof id === "string")) return false;
  if (obj.reasoning !== undefined && typeof obj.reasoning !== "string") return false;
  return true;
}

function isConfigured(): boolean {
  return Boolean(
    config.azureOpenAiApiKey.trim() &&
      config.azureOpenAiApiBaseUrl.trim() &&
      config.azureOpenAiModel.trim(),
  );
}

async function callAzureOpenAi(systemPrompt: string, userPrompt: string): Promise<string> {
  const url = buildAzureOpenAiUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.agenticCompileTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": config.azureOpenAiApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_completion_tokens: config.agenticCompileMaxTokens,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Azure OpenAI HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    const payload = (await response.json()) as AzureOpenAiResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Azure OpenAI returned empty response");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Azure OpenAI を使って knowledge 候補を goal に対して選別・並べ替えする。
 *
 * - agenticCompile が無効 or Azure OpenAI が未設定の場合は入力をそのまま返す
 * - API エラー時は graceful fallback（入力をそのまま返す）
 */
export async function agenticRefine(
  candidates: AgenticCandidate[],
  input: CompileInput,
  retrievalMode: RetrievalMode,
): Promise<AgenticRefineResult> {
  if (!config.agenticCompileEnabled) {
    return { items: candidates, agenticUsed: false };
  }

  if (!isConfigured()) {
    return { items: candidates, agenticUsed: false };
  }

  if (candidates.length === 0) {
    return { items: candidates, agenticUsed: false };
  }

  try {
    const systemPrompt = buildSystemPrompt(input, retrievalMode);
    const userPrompt = buildUserPrompt(candidates);
    const rawResponse = await callAzureOpenAi(systemPrompt, userPrompt);
    const parsed = parseAgenticOutput(rawResponse);

    if (!parsed) {
      return {
        items: candidates,
        agenticUsed: false,
        error: "AGENTIC_OUTPUT_PARSE_FAILED",
      };
    }

    // Re-order candidates based on LLM selection
    const candidateMap = new Map(candidates.map((item) => [item.id, item]));
    const selected: AgenticCandidate[] = [];
    for (const id of parsed.selectedIds) {
      const item = candidateMap.get(id);
      if (item) {
        selected.push(item);
        candidateMap.delete(id);
      }
    }

    if (selected.length === 0) {
      return {
        items: candidates,
        agenticUsed: false,
        error: "AGENTIC_EMPTY_SELECTION",
      };
    }

    return {
      items: selected,
      agenticUsed: true,
      reasoning: parsed.reasoning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      items: candidates,
      agenticUsed: false,
      error: `AGENTIC_REFINE_FAILED: ${message}`,
    };
  }
}

/**
 * Azure OpenAI の疎通確認 (doctor 用)
 */
export async function checkAzureOpenAiHealth(): Promise<{
  configured: boolean;
  reachable: boolean;
  model: string;
  endpoint: string;
  error?: string;
}> {
  const result = {
    configured: isConfigured(),
    reachable: false,
    model: config.azureOpenAiModel,
    endpoint: config.azureOpenAiApiBaseUrl,
  };

  if (!result.configured) {
    return { ...result, error: "Azure OpenAI is not configured" };
  }

  try {
    const url = buildAzureOpenAiUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "api-key": config.azureOpenAiApiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "ping" }],
          max_completion_tokens: 1,
          temperature: 0,
        }),
        signal: controller.signal,
      });
      // Any response (even 400) means the endpoint is reachable
      result.reachable = response.status < 500;
      if (!result.reachable) {
        return { ...result, error: `HTTP ${response.status}` };
      }
    } finally {
      clearTimeout(timer);
    }
    return result;
  } catch (error) {
    return {
      ...result,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
