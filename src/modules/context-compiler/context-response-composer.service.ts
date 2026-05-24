import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { ContextPackItem } from "../../shared/schemas/context-pack.schema.js";
import { groupedConfig } from "../../config.js";
import { getAgenticLlmProviders } from "../llm/agentic-llm.service.js";
import {
  isRateLimitError,
  readProviderPressureState,
  recordProviderRateLimit,
  recordProviderUsage,
} from "../llm/provider-pressure.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveAgenticCompileRouting,
} from "../settings/settings.service.js";

type ComposeInput = {
  input: CompileInput;
  retrievalMode: RetrievalMode;
  rules: ContextPackItem[];
  procedures: ContextPackItem[];
};

export type ComposeUsedKnowledge = {
  id: string;
  confidence: number;
  evidence?: string;
  outputSection?: string;
  reason?: string;
};

export type ComposeResult = {
  markdown: string;
  agenticUsed: boolean;
  usedKnowledge: ComposeUsedKnowledge[];
  error?: string;
};

type HeadingConfig = {
  focus: string;
  steps: string;
  verification: string;
  avoid: string;
};

function resolveHeadings(goal: string, changeTypes?: string[]): HeadingConfig {
  const text = goal.toLowerCase();
  const types = (changeTypes ?? []).map((t) => t.toLowerCase());

  // 1. ドキュメント系
  if (
    types.includes("docs") ||
    types.includes("wiki") ||
    types.includes("plan") ||
    text.includes("ドキュメント") ||
    text.includes("wiki") ||
    text.includes("設計書") ||
    text.includes("readme") ||
    text.includes("仕様書")
  ) {
    return {
      focus: "構成フォーカス",
      steps: "執筆手順",
      verification: "確認観点",
      avoid: "注意点",
    };
  }

  // 2. レビュー系
  if (
    types.includes("review") ||
    text.includes("レビュー") ||
    text.includes("review") ||
    text.includes("監査")
  ) {
    return {
      focus: "レビュー方針",
      steps: "レビュー手順",
      verification: "確認ポイント",
      avoid: "見落とし注意",
    };
  }

  // 3. テスト系
  if (
    types.includes("test") ||
    types.includes("qa") ||
    types.includes("spec") ||
    text.includes("テスト") ||
    text.includes("試験") ||
    text.includes("test") ||
    text.includes("spec")
  ) {
    return {
      focus: "テスト方針",
      steps: "テスト実装手順",
      verification: "アサーション・検証観点",
      avoid: "モック・環境依存注意",
    };
  }

  // 4. セットアップ・デプロイ・インフラ系
  if (
    types.includes("setup") ||
    types.includes("devops") ||
    types.includes("ci") ||
    types.includes("cd") ||
    types.includes("deploy") ||
    text.includes("構築") ||
    text.includes("設定") ||
    text.includes("セットアップ") ||
    text.includes("setup") ||
    text.includes("deploy") ||
    text.includes("ci/cd") ||
    text.includes("docker")
  ) {
    return {
      focus: "構築・設定方針",
      steps: "セットアップ手順",
      verification: "動作確認・疎通観点",
      avoid: "環境差分・セキュリティ注意",
    };
  }

  // 5. リファクタ・最適化系
  if (
    types.includes("refactor") ||
    types.includes("optimize") ||
    text.includes("リファクタ") ||
    text.includes("最適化") ||
    text.includes("refactor") ||
    text.includes("clean") ||
    text.includes("クリーンアップ")
  ) {
    return {
      focus: "リファクタリング方針",
      steps: "改善・変更手順",
      verification: "デグレード・性能検証",
      avoid: "挙動変更の防止",
    };
  }

  // 6. デバッグ・調査系
  if (
    types.includes("bugfix") ||
    types.includes("hotfix") ||
    types.includes("investigate") ||
    text.includes("バグ") ||
    text.includes("デバッグ") ||
    text.includes("調査") ||
    text.includes("エラー") ||
    text.includes("debug") ||
    text.includes("障害")
  ) {
    return {
      focus: "調査フォーカス",
      steps: "デバッグ手順",
      verification: "再現・検証観点",
      avoid: "二次バグ注意",
    };
  }

  // 7. デフォルト：通常の実装
  return { focus: "実装フォーカス", steps: "実装手順", verification: "検証観点", avoid: "注意点" };
}

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

type FallbackComposeResult = {
  markdown: string;
  usedKnowledge: ComposeUsedKnowledge[];
};

const composerJsonCompletionMaxTokens = 16_384;
const composerJsonCompletionHeadroomTokens = 512;
const composerJsonCompletionHeadroomRatio = 1.15;

function maxTokensWithJsonHeadroom(markdownTargetTokens: number): number {
  const normalizedTarget = Math.max(128, Math.floor(markdownTargetTokens));
  return Math.min(
    composerJsonCompletionMaxTokens,
    Math.max(
      normalizedTarget + composerJsonCompletionHeadroomTokens,
      Math.ceil(normalizedTarget * composerJsonCompletionHeadroomRatio),
    ),
  );
}

function modelForProvider(provider: string): string {
  switch (provider) {
    case "openai":
      return groupedConfig.openAi.model;
    case "azure-openai":
      return groupedConfig.azureOpenAi.model;
    case "bedrock":
      return groupedConfig.bedrock.model;
    case "local-llm":
      return groupedConfig.localLlm.model;
    default:
      return groupedConfig.openAi.model;
  }
}

function buildFallbackCompose(params: ComposeInput): FallbackComposeResult {
  const headings = resolveHeadings(params.input.goal, params.input.changeTypes);
  const allItems = [...params.rules, ...params.procedures];
  if (allItems.length === 0) return { markdown: "No Content", usedKnowledge: [] };
  const usedKnowledgeIds = new Set<string>();
  const trackUsed = (item: ContextPackItem) => {
    if (item.itemKind === "rule" || item.itemKind === "procedure") {
      usedKnowledgeIds.add(item.itemId);
    }
  };

  const focusLines: string[] = [
    `## ${headings.focus}`,
    "",
    `- ${normalizeLine(params.input.goal)}`,
  ];
  for (const rule of params.rules.slice(0, 2)) {
    focusLines.push(`- ${rule.title} を考慮して取り組む。`);
    trackUsed(rule);
  }

  const stepLines: string[] = ["", `## ${headings.steps}`, ""];
  if (params.procedures.length > 0) {
    let index = 1;
    for (const procedure of params.procedures.slice(0, 3)) {
      const workflow = extractSectionLines(procedure.content, "Workflow");
      const detail = workflow[0] ? `（${workflow[0]}）` : "";
      stepLines.push(`${index}. ${procedure.title}${detail}`);
      trackUsed(procedure);
      index += 1;
    }
  } else {
    let index = 1;
    for (const rule of params.rules.slice(0, 3)) {
      stepLines.push(`${index}. ${rule.title} を反映する。`);
      trackUsed(rule);
      index += 1;
    }
  }

  const verificationLines: string[] = ["", `## ${headings.verification}`, ""];
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
      verificationLines.push(`- ${item.title} の要件が成立していることを確認する。`);
      trackUsed(item);
    }
  }

  const avoidCandidates = params.procedures
    .flatMap((item) => extractSectionLines(item.content, "Avoid"))
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .slice(0, 2);
  const avoidLines: string[] = [];
  if (avoidCandidates.length > 0) {
    avoidLines.push("", `## ${headings.avoid}`, "");
    for (const item of avoidCandidates) {
      avoidLines.push(`- ${item}`);
    }
    for (const procedure of params.procedures.slice(0, 2)) {
      trackUsed(procedure);
    }
  }

  return {
    markdown: [...focusLines, ...stepLines, ...verificationLines, ...avoidLines].join("\n").trim(),
    usedKnowledge: [...usedKnowledgeIds].map((id) => ({
      id,
      confidence: 0.35,
      reason: "fallback_compose_reference",
    })),
  };
}

function buildSystemPrompt(maxTokens: number, headings: HeadingConfig): string {
  const normalizedMaxTokens = Math.max(128, Math.floor(maxTokens));
  return [
    "あなたは context_compile の最終コンテキスト編集者です。",
    "入力された knowledge 候補をそのまま列挙せず、現在の goal に直結する指示へ統合してください。回答はJSONのみ返してください。",
    "",
    "JSON 形式:",
    '{ "markdown": "...", "usedKnowledge": [{ "id": "knowledge-id", "confidence": 0.0-1.0, "evidence": "...", "outputSection": "...", "reason": "..." }] }',
    "",
    "必須ルール:",
    "- 出力は日本語 Markdown。",
    `- 見出しは \`${headings.focus}\` / \`${headings.steps}\` / \`${headings.verification}\` を必須とし、必要時のみ \`${headings.avoid}\` を追加。`,
    "- `Rules` や `Procedures` の見出しは使わない。",
    "- 入力knowledgeに無い事実を追加しない。",
    `- markdown フィールドの本文は ${normalizedMaxTokens} トークン以内を目標に収める。`,
    `- ${normalizedMaxTokens} トークンを埋める必要はない。goal達成に必要な最小限だけ書く。`,
    "- JSON は必ず完結させる。出力上限に近い場合は markdown 本文を短くしてでも、閉じ括弧・閉じ配列まで出し切る。",
    "- できるだけ短く要点を伝えること。相手はAIなので、挨拶や丁寧語で無駄にコンテキストを消費しないこと。",
    '- goal と直接関係する指示が作れない場合は、`{"markdown":"No Content","usedKnowledge":[]}` を返す。',
    "- ノイズを避け、受け手が次に行う行動へ変換する。",
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
    lines.push(`- id: ${item.itemId}`);
    lines.push(`  kind: ${item.itemKind}`);
    lines.push(`  title: ${item.title}`);
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

function looksLikeJsonPayload(value: string): boolean {
  const normalized = normalizeComposerOutput(value);
  return normalized.startsWith("{") || normalized.startsWith("[");
}

function parseUsedKnowledgeArray(
  value: unknown,
  selectableKnowledgeIds: Set<string>,
): ComposeUsedKnowledge[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Map<string, ComposeUsedKnowledge>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id || !selectableKnowledgeIds.has(id)) continue;
    const confidenceRaw = Number(candidate.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.5;
    const evidence = typeof candidate.evidence === "string" ? candidate.evidence.trim() : undefined;
    const outputSection =
      typeof candidate.outputSection === "string" ? candidate.outputSection.trim() : undefined;
    const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : undefined;
    deduped.set(id, {
      id,
      confidence,
      ...(evidence ? { evidence } : {}),
      ...(outputSection ? { outputSection } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return [...deduped.values()];
}

function parseAgenticComposerPayload(
  raw: string,
  selectableKnowledgeIds: Set<string>,
): { markdown: string; usedKnowledge: ComposeUsedKnowledge[]; error?: string } {
  const normalized = normalizeComposerOutput(raw);
  if (normalized === "No Content") {
    return { markdown: "No Content", usedKnowledge: [] };
  }

  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const markdown =
      typeof parsed.markdown === "string" ? normalizeComposerOutput(parsed.markdown) : "No Content";
    const usedKnowledge = parseUsedKnowledgeArray(parsed.usedKnowledge, selectableKnowledgeIds);
    return {
      markdown,
      usedKnowledge,
    };
  } catch {
    if (looksLikeJsonPayload(normalized)) {
      return {
        markdown: "No Content",
        usedKnowledge: [],
        error: "COMPOSER_JSON_PARSE_FAILED",
      };
    }
    return {
      markdown: normalized,
      usedKnowledge: [],
    };
  }
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
  const fallback = buildFallbackCompose(params);
  if (fallback.markdown === "No Content") {
    return { markdown: "No Content", agenticUsed: false, usedKnowledge: [] };
  }

  await ensureRuntimeSettingsLoaded();
  const routing = resolveAgenticCompileRouting();

  if (!routing.enabled) {
    return {
      markdown: fallback.markdown,
      agenticUsed: false,
      usedKnowledge: fallback.usedKnowledge,
    };
  }

  const providers = getAgenticLlmProviders(
    routing.provider,
    routing.timeoutMs,
    "context-response-composer",
    routing.fallback,
  );
  const primaryProviderName = providers[0]?.name ?? routing.provider;
  const primaryModel = modelForProvider(primaryProviderName);
  const pressure = await readProviderPressureState({
    provider: routing.provider,
    model: primaryModel,
  });
  if (pressure.cooldownActive) {
    return {
      markdown: fallback.markdown,
      agenticUsed: false,
      usedKnowledge: fallback.usedKnowledge,
      error: "CONTEXT_RESPONSE_COMPOSER_SKIPPED_RATE_LIMIT",
    };
  }
  const allowFallback = providers.length > 1;
  const fallbackErrors: string[] = [];
  let attempted = 0;
  const completionMaxTokens = maxTokensWithJsonHeadroom(routing.maxTokens);
  const headings = resolveHeadings(params.input.goal, params.input.changeTypes);
  const systemPrompt = buildSystemPrompt(routing.maxTokens, headings);
  const userPrompt = buildUserPrompt(params);
  const selectableKnowledgeIds = new Set(
    [...params.rules, ...params.procedures]
      .map((item) => item.itemId.trim())
      .filter((itemId) => itemId.length > 0),
  );

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    attempted += 1;
    const providerModel = modelForProvider(provider.name);
    void recordProviderUsage({
      provider: provider.name,
      model: providerModel,
      source: "context-response-composer",
      kind: "interactive",
    }).catch(() => undefined);
    try {
      const response = await provider.chat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: completionMaxTokens,
        temperature: 0,
        responseFormat: "json",
      });
      const parsed = parseAgenticComposerPayload(response.content, selectableKnowledgeIds);
      if (parsed.error) {
        if (allowFallback) {
          fallbackErrors.push(`${provider.name}:${parsed.error}`);
          continue;
        }
        return {
          markdown: fallback.markdown,
          agenticUsed: false,
          usedKnowledge: fallback.usedKnowledge,
          error: parsed.error,
        };
      }
      if (parsed.markdown === "No Content") {
        return { markdown: "No Content", agenticUsed: true, usedKnowledge: [] };
      }
      if (!looksGoalAligned(parsed.markdown, params.input.goal)) {
        return { markdown: "No Content", agenticUsed: true, usedKnowledge: [] };
      }
      return {
        markdown: parsed.markdown,
        agenticUsed: true,
        usedKnowledge: parsed.usedKnowledge,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitError(error)) {
        void recordProviderRateLimit({
          provider: provider.name,
          model: providerModel,
          source: "context-response-composer",
          error,
        }).catch(() => undefined);
      }
      if (allowFallback) {
        fallbackErrors.push(`${provider.name}:${message}`);
        continue;
      }
      return {
        markdown: fallback.markdown,
        agenticUsed: false,
        usedKnowledge: fallback.usedKnowledge,
        error: `CONTEXT_RESPONSE_COMPOSE_FAILED: ${message}`,
      };
    }
  }

  if (attempted === 0) {
    return {
      markdown: fallback.markdown,
      agenticUsed: false,
      usedKnowledge: fallback.usedKnowledge,
    };
  }

  if (fallbackErrors.length > 0) {
    return {
      markdown: fallback.markdown,
      agenticUsed: false,
      usedKnowledge: fallback.usedKnowledge,
      error: `CONTEXT_RESPONSE_COMPOSE_FAILED: ${fallbackErrors.join(" | ")}`,
    };
  }

  return { markdown: fallback.markdown, agenticUsed: false, usedKnowledge: fallback.usedKnowledge };
}
