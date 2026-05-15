import { groupedConfig } from "../../config.js";
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
    "## 出力形式",
    "必ず以下の JSON フォーマットのみを返してください。他のテキストは一切含めないでください。",
    "```json",
    "{",
    '  "selectedIds": ["選別した知識のID", ...],',
    '  "reasoning": "なぜこれらの知識を選別したか、あるいはなぜ一つも選別しなかったかの理由（簡潔に）"',
    "}",
    "```",
    "",
    "## 選別基準",
    "- **厳格な有用性評価**: 提示する知識が、現在のゴール達成に**直接的かつ具体的**に寄与するかを評価してください。",
    "- **ノイズの排除**: 「UI関連だから」といった漠然とした理由は不採用です。確証がない知識は、エージェントの思考を汚染する「毒」となります。",
    "- **勇気ある空配列**: 確信が持てない場合は、迷わず `selectedIds` を空配列 `[]` にしてください。有用な情報がないと判断することは、誤った情報を与えるよりも遥かに「賢い判断」です。",
    "- 知識が一つも選別されない場合でも、関連するコード断片や警告があればそれらは返されます。確証がない知識を無理に選ぶより、空配列を優先してください。",
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
    "selectedIds は入力候補の id を relevance 順に列挙してください。",
    "ゴールに無関係な知識しかない場合は、必ず空配列 `[]` を返してください。",
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
  const tryParse = (text: string): AgenticLlmOutput | null => {
    try {
      const parsed = JSON.parse(text);
      // Array format fallback
      if (Array.isArray(parsed)) {
        if (!parsed.every((item) => typeof item === "string")) {
          return null;
        }
        return { selectedIds: parsed, reasoning: "Converted from array format" };
      }
      if (isAgenticOutput(parsed)) return parsed;
    } catch {
      return null;
    }
    return null;
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match?.[1]) {
    const wrapped = tryParse(match[1].trim());
    if (wrapped) return wrapped;
  }

  const braceMatch = raw.match(/\{[\s\S]*"selectedIds"[\s\S]*\}/);
  if (braceMatch) {
    const braced = tryParse(braceMatch[0]);
    if (braced) return braced;
  }

  // Last resort: check if it's just a raw JSON array string
  const arrayMatch = raw.match(/\[[\s\S]*?\]/);
  if (arrayMatch) {
    const arrayed = tryParse(arrayMatch[0]);
    if (arrayed) return arrayed;
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
  if (!groupedConfig.agenticCompile.enabled) {
    return { items: candidates, agenticUsed: false };
  }

  if (candidates.length === 0) {
    return { items: candidates, agenticUsed: false };
  }

  const providers = getAgenticLlmProviders(
    groupedConfig.agenticCompile.provider,
    groupedConfig.agenticCompile.timeoutMs,
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
        maxTokens: groupedConfig.agenticCompile.maxTokens,
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
    console.error("[agenticRefine] All providers failed:", fallbackErrors);
    return {
      items: candidates,
      agenticUsed: false,
      error: formatAutoFallbackError(fallbackErrors),
    };
  }

  return { items: candidates, agenticUsed: false };
}
