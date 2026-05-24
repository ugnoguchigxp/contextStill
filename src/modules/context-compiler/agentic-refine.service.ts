import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { getAgenticLlmProviders } from "../llm/agentic-llm.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveAgenticCompileRouting,
} from "../settings/settings.service.js";

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
    "厳密な JSON でなくてよい。最小限の構造だけを短く返してください。",
    '推奨形: selectedIds: ["選別した知識のID"], reasoning: "簡潔な理由"',
    "reasoning は省略してよい。selectedIds が分かればよい。",
    "",
    "## 選別基準",
    "- **厳格な有用性評価**: 提示する知識が、現在のゴール達成に**直接的かつ具体的**に寄与するかを評価してください。",
    "- **ノイズの排除**: 「UI関連だから」といった漠然とした理由は不採用です。確証がない知識は、エージェントの思考を汚染する「毒」となります。",
    "- **勇気ある空配列**: 確信が持てない場合は、迷わず `selectedIds` を空配列 `[]` にしてください。有用な情報がないと判断することは、誤った情報を与えるよりも遥かに「賢い判断」です。",
    "- 知識が一つも選別されない場合でも、関連するコード断片や警告があればそれらは返されます。確証がない知識を無理に選ぶより、空配列を優先してください。",
    "",
    "## タスク情報",
    `- goal: ${input.goal}`,
    `- retrievalMode: ${retrievalMode}`,
  ];

  if (input.technologies && input.technologies.length > 0) {
    lines.push(`- technologies: ${input.technologies.join(", ")}`);
  }
  if (input.changeTypes && input.changeTypes.length > 0) {
    lines.push(`- changeTypes: ${input.changeTypes.join(", ")}`);
  }
  if (input.domains && input.domains.length > 0) {
    lines.push(`- domains: ${input.domains.join(", ")}`);
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
  const parsed = parseLlmJsonLike(raw);
  if (parsed) {
    return normalizeAgenticOutput(parsed.value);
  }

  return parseAgenticLabelOutput(raw);
}

function normalizeStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.every((id) => typeof id === "string") ? value : null;
  }
  if (typeof value === "string") {
    const ids = value
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    return ids.length > 0 ? ids : null;
  }
  return null;
}

function normalizeAgenticOutput(value: unknown): AgenticLlmOutput | null {
  if (Array.isArray(value)) {
    const selectedIds = normalizeStringArray(value);
    return selectedIds ? { selectedIds, reasoning: "Converted from array format" } : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const selectedIds =
    normalizeStringArray(obj.selectedIds) ??
    normalizeStringArray(obj.ids) ??
    normalizeStringArray(obj.knowledgeIds) ??
    normalizeStringArray(obj.selected);
  if (!selectedIds) return null;
  return {
    selectedIds,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
  };
}

function parseAgenticLabelOutput(raw: string): AgenticLlmOutput | null {
  const selectedMatch = raw.match(/(?:selectedIds|selected|ids|knowledgeIds)\s*[:：]\s*([^\n]+)/i);
  if (!selectedMatch?.[1]) return null;
  const selectedIds = selectedMatch[1]
    .replace(/[[\]"'`]/g, "")
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (selectedIds.length === 0) return null;
  const reasoning = raw.match(/reasoning\s*[:：]\s*([^\n]+)/i)?.[1]?.trim();
  return { selectedIds, reasoning };
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
  await ensureRuntimeSettingsLoaded();
  const routing = resolveAgenticCompileRouting();

  if (!routing.enabled) {
    return { items: candidates, agenticUsed: false };
  }

  if (candidates.length === 0) {
    return { items: candidates, agenticUsed: false };
  }

  const providers = getAgenticLlmProviders(
    routing.provider,
    routing.timeoutMs,
    "context-compiler",
    routing.fallback,
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
        maxTokens: routing.maxTokens,
        temperature: 0,
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
        return {
          items: candidates,
          agenticUsed: false,
          reasoning: parsed.reasoning ? `Fallback to all candidates: ${parsed.reasoning}` : undefined,
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
