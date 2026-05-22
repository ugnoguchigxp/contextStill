import { groupedConfig } from "../../config.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { ContextPackItem } from "../../shared/schemas/context-pack.schema.js";
import { getAgenticLlmProviders } from "../llm/agentic-llm.service.js";

type ComposeInput = {
  input: CompileInput;
  retrievalMode: RetrievalMode;
  rules: ContextPackItem[];
  procedures: ContextPackItem[];
};

export type ComposeResult = {
  markdown: string;
  agenticUsed: boolean;
  error?: string;
};

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstSentence(text: string, maxChars = 120): string {
  const normalized = normalizeLine(text);
  if (!normalized) return "";
  const sentenceMatch = normalized.match(/^(.+?[。.!?])/u);
  const sentence = sentenceMatch?.[1] ?? normalized;
  if (sentence.length <= maxChars) return sentence;
  return `${sentence.slice(0, maxChars).trim()}...`;
}

function extractSectionLines(
  content: string,
  label: "Workflow" | "Verification" | "Avoid",
): string[] {
  const lines = content.split("\n");
  let inSection = false;
  const captured: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.match(/^[A-Za-z][A-Za-z\s-]*:/)) {
      inSection = line.toLowerCase().startsWith(`${label.toLowerCase()}:`);
      continue;
    }
    if (!inSection) continue;
    if (line.match(/^(?:\d+\.\s+|-+\s+|・\s+|•\s+)/)) {
      captured.push(line.replace(/^(?:\d+\.\s+|-+\s+|・\s+|•\s+)/, "").trim());
      continue;
    }
    captured.push(line);
  }

  return captured.filter(Boolean);
}

function buildFallbackMarkdown(params: ComposeInput): string {
  const allItems = [...params.rules, ...params.procedures];
  if (allItems.length === 0) return "No Content";

  const focusLines: string[] = ["## 実装フォーカス", "", `- ${normalizeLine(params.input.goal)}`];
  for (const rule of params.rules.slice(0, 2)) {
    focusLines.push(`- ${rule.title} を満たす実装境界を先に固定する。`);
  }

  const stepLines: string[] = ["", "## 実装手順", ""];
  if (params.procedures.length > 0) {
    let index = 1;
    for (const procedure of params.procedures.slice(0, 3)) {
      const workflow = extractSectionLines(procedure.content, "Workflow");
      const detail = workflow[0] ? `（${workflow[0]}）` : "";
      stepLines.push(`${index}. ${procedure.title}${detail}`);
      index += 1;
    }
  } else {
    let index = 1;
    for (const rule of params.rules.slice(0, 3)) {
      stepLines.push(`${index}. ${rule.title} を実装へ反映する。`);
      index += 1;
    }
  }

  const verificationLines: string[] = ["", "## 検証観点", ""];
  const verificationCandidates = params.procedures
    .flatMap((item) => extractSectionLines(item.content, "Verification"))
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .slice(0, 3);
  if (verificationCandidates.length > 0) {
    for (const item of verificationCandidates) {
      verificationLines.push(`- ${item}`);
    }
  } else {
    for (const item of [...params.rules, ...params.procedures].slice(0, 2)) {
      verificationLines.push(`- ${item.title} の要件が実装後に成立していることを確認する。`);
    }
  }

  const avoidCandidates = params.procedures
    .flatMap((item) => extractSectionLines(item.content, "Avoid"))
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .slice(0, 2);
  const avoidLines: string[] = [];
  if (avoidCandidates.length > 0) {
    avoidLines.push("", "## 注意点", "");
    for (const item of avoidCandidates) {
      avoidLines.push(`- ${item}`);
    }
  }

  return [...focusLines, ...stepLines, ...verificationLines, ...avoidLines].join("\n").trim();
}

function buildSystemPrompt(): string {
  return [
    "あなたは context_compile の最終コンテキスト編集者です。",
    "入力された knowledge 候補をそのまま列挙せず、現在の goal に直結する実装指示へ統合してください。",
    "",
    "必須ルール:",
    "- 出力は日本語 Markdown。",
    "- 見出しは `実装フォーカス` / `実装手順` / `検証観点` を必須とし、必要時のみ `注意点` を追加。",
    "- `Rules` や `Procedures` の見出しは使わない。",
    "- 入力knowledgeに無い事実を追加しない。",
    "- 回答は 5000 トークン以内に収める。",
    "- 5000 トークンを埋める必要はない。goal達成に必要な最小限だけ書く。",
    "- goal と直接関係する指示が作れない場合は、`No Content` のみを返す。",
    "- ノイズを避け、実装者が次に行う行動へ変換する。",
  ].join("\n");
}

function buildUserPrompt(params: ComposeInput): string {
  const items = [...params.rules, ...params.procedures].slice(0, 8);
  const lines: string[] = [
    `goal: ${normalizeLine(params.input.goal)}`,
    `retrievalMode: ${params.retrievalMode}`,
  ];
  if (params.input.changeTypes?.length) {
    lines.push(`changeTypes: ${params.input.changeTypes.join(", ")}`);
  }
  if (params.input.technologies?.length) {
    lines.push(`technologies: ${params.input.technologies.join(", ")}`);
  }
  if (params.input.domains?.length) {
    lines.push(`domains: ${params.input.domains.join(", ")}`);
  }
  lines.push("", "knowledge candidates:");
  for (const item of items) {
    lines.push(`- ${item.itemKind}: ${item.title}`);
    lines.push(`  summary: ${firstSentence(item.content, 160)}`);
  }
  return lines.join("\n");
}

function normalizeComposerOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "No Content";
  if (/^no content$/i.test(trimmed)) return "No Content";

  const fenceMatch = trimmed.match(/^```(?:markdown|md|text)?\n([\s\S]*?)\n```$/i);
  const unfenced = fenceMatch ? fenceMatch[1].trim() : trimmed;
  if (!unfenced) return "No Content";
  if (/^no content$/i.test(unfenced)) return "No Content";
  return unfenced;
}

function looksGoalAligned(markdown: string, goal: string): boolean {
  if (markdown === "No Content") return false;
  const goalTokens = (goal.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(
    (token) => !["with", "from", "into", "that", "this"].includes(token),
  );
  if (goalTokens.length === 0) return true;
  const text = markdown.toLowerCase();
  return goalTokens.some((token) => text.includes(token));
}

export async function composeContextResponse(params: ComposeInput): Promise<ComposeResult> {
  const fallback = buildFallbackMarkdown(params);
  if (fallback === "No Content") return { markdown: "No Content", agenticUsed: false };

  if (!groupedConfig.agenticCompile.enabled) {
    return { markdown: fallback, agenticUsed: false };
  }

  const providers = getAgenticLlmProviders(
    groupedConfig.agenticCompile.provider,
    groupedConfig.agenticCompile.timeoutMs,
    "context-response-composer",
  );
  const allowFallback = providers.length > 1;
  const fallbackErrors: string[] = [];
  let attempted = 0;
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(params);

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    attempted += 1;
    try {
      const response = await provider.chat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: Math.min(groupedConfig.agenticCompile.maxTokens, 1200),
        temperature: 0,
        responseFormat: "text",
      });
      const normalized = normalizeComposerOutput(response.content);
      if (normalized === "No Content") {
        return { markdown: "No Content", agenticUsed: true };
      }
      if (!looksGoalAligned(normalized, params.input.goal)) {
        return { markdown: "No Content", agenticUsed: true };
      }
      return { markdown: normalized, agenticUsed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (allowFallback) {
        fallbackErrors.push(`${provider.name}:${message}`);
        continue;
      }
      return {
        markdown: fallback,
        agenticUsed: false,
        error: `CONTEXT_RESPONSE_COMPOSE_FAILED: ${message}`,
      };
    }
  }

  if (attempted === 0) {
    return { markdown: fallback, agenticUsed: false };
  }

  if (fallbackErrors.length > 0) {
    return {
      markdown: fallback,
      agenticUsed: false,
      error: `CONTEXT_RESPONSE_COMPOSE_FAILED: ${fallbackErrors.join(" | ")}`,
    };
  }

  return { markdown: fallback, agenticUsed: false };
}
