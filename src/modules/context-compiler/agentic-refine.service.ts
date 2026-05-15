import { config } from "../../config.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { getAgenticLlmProviders } from "../llm/agentic-llm.service.js";

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

type AgenticLlmOutput = {
  selectedIds: string[];
  reasoning?: string;
};

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
    const parsed = JSON.parse(raw) as unknown;
    if (isAgenticOutput(parsed)) return parsed;
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim()) as unknown;
        if (isAgenticOutput(parsed)) return parsed;
      } catch {
        // fall through
      }
    }

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

function selectCandidates(
  candidates: AgenticCandidate[],
  selectedIds: string[],
): AgenticCandidate[] {
  const candidateMap = new Map(candidates.map((item) => [item.id, item]));
  const selected: AgenticCandidate[] = [];

  for (const id of selectedIds) {
    const item = candidateMap.get(id);
    if (item) {
      selected.push(item);
      candidateMap.delete(id);
    }
  }

  return selected;
}

function formatAutoFallbackError(messages: string[]): string {
  const detail = messages.join(" | ");
  return `AGENTIC_REFINE_FAILED: ${detail}`;
}

/**
 * LLM を使って knowledge 候補を goal に対して選別・並べ替えする。
 *
 * - agenticCompile が無効、または provider が未設定の場合は入力をそのまま返す
 * - provider エラー時は graceful fallback（入力をそのまま返す）
 */
export async function agenticRefine(
  candidates: AgenticCandidate[],
  input: CompileInput,
  retrievalMode: RetrievalMode,
): Promise<AgenticRefineResult> {
  if (!config.agenticCompileEnabled) {
    return { items: candidates, agenticUsed: false };
  }

  if (candidates.length === 0) {
    return { items: candidates, agenticUsed: false };
  }

  const providers = getAgenticLlmProviders(
    config.agenticCompileProvider,
    config.agenticCompileTimeoutMs,
  );
  const allowFallback = providers.length > 1;
  const fallbackErrors: string[] = [];
  let attempted = 0;

  const systemPrompt = buildSystemPrompt(input, retrievalMode);
  const userPrompt = buildUserPrompt(candidates);

  for (const provider of providers) {
    if (!provider.isConfigured()) {
      continue;
    }

    attempted += 1;

    try {
      const response = await provider.chat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: config.agenticCompileMaxTokens,
        temperature: 0,
        responseFormat: "json",
      });

      const parsed = parseAgenticOutput(response.content);
      if (!parsed) {
        if (allowFallback) {
          fallbackErrors.push(`${provider.name}:AGENTIC_OUTPUT_PARSE_FAILED`);
          continue;
        }
        return {
          items: candidates,
          agenticUsed: false,
          error: "AGENTIC_OUTPUT_PARSE_FAILED",
        };
      }

      const selected = selectCandidates(candidates, parsed.selectedIds);
      if (selected.length === 0) {
        if (allowFallback) {
          fallbackErrors.push(`${provider.name}:AGENTIC_EMPTY_SELECTION`);
          continue;
        }
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
      if (allowFallback) {
        fallbackErrors.push(`${provider.name}:${message}`);
        continue;
      }
      return {
        items: candidates,
        agenticUsed: false,
        error: `AGENTIC_REFINE_FAILED: ${message}`,
      };
    }
  }

  if (attempted === 0) {
    return { items: candidates, agenticUsed: false };
  }

  if (fallbackErrors.length > 0) {
    return {
      items: candidates,
      agenticUsed: false,
      error: formatAutoFallbackError(fallbackErrors),
    };
  }

  return { items: candidates, agenticUsed: false };
}
