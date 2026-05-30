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

type ComposeResponseStyle = "skill" | "narrative";
type ComposeCandidateSufficiency = "enough" | "limited" | "insufficient";

type ComposePlan = {
  headings: HeadingConfig;
  includeAvoidSection: boolean;
  ruleQueryHints: string[];
  procedureQueryHints: string[];
  exclusionHints: string[];
  responseStyle: ComposeResponseStyle;
  styleReason: string;
  styleConfidence: number;
  candidateSufficiency: ComposeCandidateSufficiency;
};

const composePlannerHintLimit = 6;
const composeHeadingMaxChars = 32;
const composeStyleReasonMaxChars = 120;
const composeStyleConfidenceMin = 0;
const composeStyleConfidenceMax = 1;
const composeStyleConfidenceFloor = 0.7;

function resolveDefaultHeadings(retrievalMode: RetrievalMode): HeadingConfig {
  switch (retrievalMode) {
    case "architecture_context":
      return {
        focus: "実装計画フォーカス",
        steps: "実装計画手順",
        verification: "計画検証観点",
        avoid: "スコープ注意点",
      };
    case "review_context":
      return {
        focus: "レビュー方針",
        steps: "レビュー手順",
        verification: "確認ポイント",
        avoid: "見落とし注意",
      };
    case "debug_context":
      return {
        focus: "調査フォーカス",
        steps: "デバッグ手順",
        verification: "再現・検証観点",
        avoid: "二次バグ注意",
      };
    case "procedure_context":
      return {
        focus: "作業フォーカス",
        steps: "実行手順",
        verification: "確認観点",
        avoid: "注意点",
      };
    case "learning_context":
      return {
        focus: "学習フォーカス",
        steps: "実践手順",
        verification: "理解確認",
        avoid: "誤解注意",
      };
    default:
      return {
        focus: "実装フォーカス",
        steps: "実装手順",
        verification: "検証観点",
        avoid: "注意点",
      };
  }
}

function defaultComposePlan(retrievalMode: RetrievalMode): ComposePlan {
  return {
    headings: resolveDefaultHeadings(retrievalMode),
    includeAvoidSection: false,
    ruleQueryHints: [],
    procedureQueryHints: [],
    exclusionHints: [],
    responseStyle: "narrative",
    styleReason: "default_plan",
    styleConfidence: 0.5,
    candidateSufficiency: "limited",
  };
}

function sanitizeHeading(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = normalizeLine(value)
    .replace(/^#+\s*/, "")
    .slice(0, composeHeadingMaxChars)
    .trim();
  return normalized || fallback;
}

function sanitizeHintArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeLine(entry).slice(0, 48);
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= composePlannerHintLimit) break;
  }
  return [...deduped];
}

function sanitizeStyleReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = normalizeLine(value).slice(0, composeStyleReasonMaxChars);
  return normalized || fallback;
}

function sanitizeStyleConfidence(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(composeStyleConfidenceMin, Math.min(composeStyleConfidenceMax, parsed));
}

function sanitizeResponseStyle(
  value: unknown,
  fallback: ComposeResponseStyle,
): ComposeResponseStyle {
  if (value === "skill" || value === "narrative") return value;
  return fallback;
}

function sanitizeCandidateSufficiency(
  value: unknown,
  fallback: ComposeCandidateSufficiency,
): ComposeCandidateSufficiency {
  if (value === "enough" || value === "limited" || value === "insufficient") return value;
  return fallback;
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
const composerPlannerMinTokens = 384;
const composerPlannerMaxTokens = 2048;

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

function plannerMaxTokens(markdownTargetTokens: number): number {
  const normalizedTarget = Math.max(128, Math.floor(markdownTargetTokens));
  return Math.min(
    composerPlannerMaxTokens,
    Math.max(composerPlannerMinTokens, Math.floor(normalizedTarget * 0.35)),
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

function buildFallbackCompose(params: ComposeInput, plan: ComposePlan): FallbackComposeResult {
  const { headings } = plan;
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
  if (plan.includeAvoidSection || avoidCandidates.length > 0) {
    avoidLines.push("", `## ${headings.avoid}`, "");
    if (avoidCandidates.length > 0) {
      for (const item of avoidCandidates) {
        avoidLines.push(`- ${item}`);
      }
      for (const procedure of params.procedures.slice(0, 2)) {
        trackUsed(procedure);
      }
    } else {
      for (const item of [...params.rules, ...params.procedures].slice(0, 2)) {
        avoidLines.push(`- ${item.title} を適用する際の前提条件を明確にする。`);
        trackUsed(item);
      }
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

function buildPlanSystemPrompt(): string {
  return [
    "あなたは context_compile の返答構成プランナーです。",
    "goal と候補要約だけを使って、次ラウンドで使う返答構成・出力形式・検索ヒントを JSON で設計してください。",
    "",
    "JSON 形式:",
    '{ "headings": { "focus": "...", "steps": "...", "verification": "...", "avoid": "..." }, "includeAvoidSection": true, "ruleQueryHints": ["..."], "procedureQueryHints": ["..."], "exclusionHints": ["..."], "responseStyle": "skill|narrative", "styleReason": "...", "styleConfidence": 0.0, "candidateSufficiency": "enough|limited|insufficient" }',
    "",
    "必須ルール:",
    "- 回答は JSON のみ。Markdown や説明文は返さない。",
    "- 見出しは goal に合わせて自然な日本語で作る。",
    "- ruleQueryHints / procedureQueryHints は、候補検索・選別で使える短い語句を2-6件に絞る。",
    "- exclusionHints は、今回ノイズになりやすい語句を必要時のみ入れる。",
    "- Goal が再利用可能な手順を求め、候補が十分な場合は responseStyle=skill を優先する。",
    "- 候補が不足している場合は responseStyle=narrative を選ぶ。",
    "- styleReason は1文で簡潔に書く。",
    "- styleConfidence は 0.0-1.0 で返す。",
    "- candidateSufficiency は enough / limited / insufficient のいずれかで返す。",
    "- 過剰な一般論は避け、goal達成に必要な最小限へ絞る。",
  ].join("\n");
}

function buildComposerSystemPrompt(maxTokens: number, plan: ComposePlan): string {
  const normalizedMaxTokens = Math.max(128, Math.floor(maxTokens));
  const headings = plan.headings;
  const headingRule =
    plan.responseStyle === "skill"
      ? "- 見出しは `## Use when` / `## Workflow` / `## Verification` / `## Avoid` をこの順で必ず出す。"
      : plan.includeAvoidSection
        ? `- 見出しは \`${headings.focus}\` / \`${headings.steps}\` / \`${headings.verification}\` / \`${headings.avoid}\` をこの順で必ず出す。`
        : `- 見出しは \`${headings.focus}\` / \`${headings.steps}\` / \`${headings.verification}\` をこの順で必ず出す。必要な場合のみ \`${headings.avoid}\` を追加。`;
  const styleRule =
    plan.responseStyle === "skill"
      ? "- 出力は再利用可能な手順書として書き、Workflow は番号付き手順で具体化する。"
      : "- 出力は実装・調査判断に使える narrative コンテキストとして要点をまとめる。";
  return [
    "あなたは context_compile の最終コンテキスト編集者です。",
    "入力された knowledge 候補をそのまま列挙せず、現在の goal に直結する指示へ統合してください。回答はJSONのみ返してください。",
    "",
    "JSON 形式:",
    '{ "markdown": "...", "usedKnowledge": [{ "id": "knowledge-id", "confidence": 0.0-1.0, "evidence": "...", "outputSection": "...", "reason": "..." }] }',
    "",
    "必須ルール:",
    "- 出力は日本語 Markdown。",
    headingRule,
    styleRule,
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

function normalizedHintSet(hints: string[]): Set<string> {
  return new Set(hints.map((hint) => hint.toLowerCase()));
}

function countHintMatches(text: string, hints: Set<string>): number {
  if (hints.size === 0) return 0;
  const normalized = text.toLowerCase();
  let matches = 0;
  for (const hint of hints) {
    if (!hint) continue;
    if (normalized.includes(hint)) matches += 1;
  }
  return matches;
}

function selectPromptKnowledgeCandidates(
  params: ComposeInput,
  plan: ComposePlan,
): ContextPackItem[] {
  const ruleHintSet = normalizedHintSet(plan.ruleQueryHints);
  const procedureHintSet = normalizedHintSet(plan.procedureQueryHints);
  const exclusionHintSet = normalizedHintSet(plan.exclusionHints);
  const scoreItem = (item: ContextPackItem): number => {
    const summary = firstSentence(item.content, 200);
    const text = `${item.title}\n${summary}`;
    const includeHints = item.itemKind === "rule" ? ruleHintSet : procedureHintSet;
    const positive = countHintMatches(text, includeHints);
    const negative = countHintMatches(text, exclusionHintSet);
    return positive * 8 - negative * 4 + item.score;
  };
  const rankedRules = [...params.rules].sort((a, b) => scoreItem(b) - scoreItem(a));
  const rankedProcedures = [...params.procedures].sort((a, b) => scoreItem(b) - scoreItem(a));
  const selected: ContextPackItem[] = [];
  const pushUnique = (item: ContextPackItem) => {
    if (selected.some((picked) => picked.itemId === item.itemId)) return;
    selected.push(item);
  };
  for (const item of rankedRules.slice(0, 4)) pushUnique(item);
  for (const item of rankedProcedures.slice(0, 4)) pushUnique(item);
  for (const item of [...rankedRules, ...rankedProcedures]) {
    if (selected.length >= 8) break;
    pushUnique(item);
  }
  return selected;
}

function buildPlanUserPrompt(params: ComposeInput): string {
  const topRules = params.rules.slice(0, 4).map((item) => item.title);
  const topProcedures = params.procedures.slice(0, 4).map((item) => item.title);
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
  lines.push(`ruleCandidates: ${params.rules.length}`);
  lines.push(`procedureCandidates: ${params.procedures.length}`);
  lines.push(`topRuleTitles: ${topRules.length > 0 ? topRules.join(" | ") : "(none)"}`);
  lines.push(
    `topProcedureTitles: ${topProcedures.length > 0 ? topProcedures.join(" | ") : "(none)"}`,
  );
  lines.push("", "output requirements:");
  lines.push("- JSON only");
  lines.push("- sections should feel natural for this goal");
  lines.push("- include concise query hints");
  lines.push("- decide responseStyle from goal + candidate sufficiency");
  return lines.join("\n");
}

function buildComposerUserPrompt(params: ComposeInput, plan: ComposePlan): string {
  const items = selectPromptKnowledgeCandidates(params, plan);
  const lines: string[] = [
    `goal: ${normalizeLine(params.input.goal)}`,
    `retrievalMode: ${params.retrievalMode}`,
    `compositionPlan: ${JSON.stringify(plan)}`,
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

function parseComposePlanPayload(
  raw: string,
  fallbackPlan: ComposePlan,
): { plan: ComposePlan; error?: string } {
  const normalized = normalizeComposerOutput(raw);
  if (normalized === "No Content") {
    return { plan: fallbackPlan, error: "COMPOSER_PLAN_NO_CONTENT" };
  }
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const headingsRecord =
      parsed.headings && typeof parsed.headings === "object"
        ? (parsed.headings as Record<string, unknown>)
        : {};
    const headings: HeadingConfig = {
      focus: sanitizeHeading(headingsRecord.focus, fallbackPlan.headings.focus),
      steps: sanitizeHeading(headingsRecord.steps, fallbackPlan.headings.steps),
      verification: sanitizeHeading(
        headingsRecord.verification,
        fallbackPlan.headings.verification,
      ),
      avoid: sanitizeHeading(headingsRecord.avoid, fallbackPlan.headings.avoid),
    };
    return {
      plan: {
        headings,
        includeAvoidSection:
          typeof parsed.includeAvoidSection === "boolean"
            ? parsed.includeAvoidSection
            : fallbackPlan.includeAvoidSection,
        ruleQueryHints: sanitizeHintArray(parsed.ruleQueryHints),
        procedureQueryHints: sanitizeHintArray(parsed.procedureQueryHints),
        exclusionHints: sanitizeHintArray(parsed.exclusionHints),
        responseStyle: sanitizeResponseStyle(parsed.responseStyle, fallbackPlan.responseStyle),
        styleReason: sanitizeStyleReason(parsed.styleReason, fallbackPlan.styleReason),
        styleConfidence: sanitizeStyleConfidence(
          parsed.styleConfidence,
          fallbackPlan.styleConfidence,
        ),
        candidateSufficiency: sanitizeCandidateSufficiency(
          parsed.candidateSufficiency,
          fallbackPlan.candidateSufficiency,
        ),
      },
    };
  } catch {
    if (looksLikeJsonPayload(normalized)) {
      return { plan: fallbackPlan, error: "COMPOSER_PLAN_JSON_PARSE_FAILED" };
    }
    return { plan: fallbackPlan, error: "COMPOSER_PLAN_NON_JSON" };
  }
}

function withNarrativeStyle(plan: ComposePlan, reason: string): ComposePlan {
  return {
    ...plan,
    responseStyle: "narrative",
    styleReason: sanitizeStyleReason(reason, "forced_narrative"),
    includeAvoidSection: false,
  };
}

function enforceStyleGuards(plan: ComposePlan): { plan: ComposePlan; downgradedReason?: string } {
  if (plan.responseStyle !== "skill") {
    return { plan };
  }
  if (plan.styleConfidence < composeStyleConfidenceFloor) {
    return {
      plan: withNarrativeStyle(plan, `styleConfidence below ${composeStyleConfidenceFloor}`),
      downgradedReason: "COMPOSER_STYLE_DOWNGRADED_CONFIDENCE",
    };
  }
  if (plan.candidateSufficiency !== "enough") {
    return {
      plan: withNarrativeStyle(plan, `candidateSufficiency=${plan.candidateSufficiency}`),
      downgradedReason: "COMPOSER_STYLE_DOWNGRADED_CANDIDATE_INSUFFICIENT",
    };
  }
  return { plan };
}

function hasSkillSection(markdown: string, section: string): boolean {
  return new RegExp(`^##\\s+${section}\\s*$`, "im").test(markdown);
}

function validateSkillMarkdown(markdown: string): boolean {
  return (
    hasSkillSection(markdown, "Use when") &&
    hasSkillSection(markdown, "Workflow") &&
    hasSkillSection(markdown, "Verification") &&
    hasSkillSection(markdown, "Avoid")
  );
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
  const defaultPlan = defaultComposePlan(params.retrievalMode);
  const defaultFallback = buildFallbackCompose(params, defaultPlan);
  if (defaultFallback.markdown === "No Content") {
    return { markdown: "No Content", agenticUsed: false, usedKnowledge: [] };
  }

  await ensureRuntimeSettingsLoaded();
  const routing = resolveAgenticCompileRouting();

  if (!routing.enabled) {
    return {
      markdown: defaultFallback.markdown,
      agenticUsed: false,
      usedKnowledge: defaultFallback.usedKnowledge,
    };
  }

  const providers = getAgenticLlmProviders(
    routing.provider,
    routing.timeoutMs,
    "context-response-composer",
    routing.fallback,
    routing.azureDeploymentSlots,
  );
  const primaryProviderName = providers[0]?.name ?? routing.provider;
  const primaryModel = modelForProvider(primaryProviderName);
  const pressure = await readProviderPressureState({
    provider: routing.provider,
    model: primaryModel,
  });
  if (pressure.cooldownActive) {
    return {
      markdown: defaultFallback.markdown,
      agenticUsed: false,
      usedKnowledge: defaultFallback.usedKnowledge,
      error: "CONTEXT_RESPONSE_COMPOSER_SKIPPED_RATE_LIMIT",
    };
  }
  const allowFallback = providers.length > 1;
  const fallbackErrors: string[] = [];
  let attempted = 0;
  const completionMaxTokens = maxTokensWithJsonHeadroom(routing.maxTokens);
  const plannerCompletionMaxTokens = plannerMaxTokens(routing.maxTokens);
  const plannerSystemPrompt = buildPlanSystemPrompt();
  const plannerUserPrompt = buildPlanUserPrompt(params);
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
    let composePlan = defaultPlan;
    let plannerError: string | undefined;
    try {
      const plannerResponse = await provider.chat({
        messages: [
          { role: "system", content: plannerSystemPrompt },
          { role: "user", content: plannerUserPrompt },
        ],
        maxTokens: plannerCompletionMaxTokens,
        temperature: 0,
        responseFormat: "json",
      });
      const parsedPlan = parseComposePlanPayload(plannerResponse.content, defaultPlan);
      composePlan = parsedPlan.plan;
      plannerError = parsedPlan.error;
    } catch (error) {
      const plannerMessage = error instanceof Error ? error.message : String(error);
      plannerError = `CONTEXT_RESPONSE_PLAN_FAILED: ${plannerMessage}`;
      if (isRateLimitError(error)) {
        void recordProviderRateLimit({
          provider: provider.name,
          model: providerModel,
          source: "context-response-composer",
          error,
        }).catch(() => undefined);
      }
    }
    const guarded = enforceStyleGuards(composePlan);
    const effectivePlan = guarded.plan;
    if (guarded.downgradedReason) {
      plannerError = [plannerError, guarded.downgradedReason].filter(Boolean).join(" | ");
    }
    const fallbackPlanForThisRound =
      effectivePlan.responseStyle === "skill"
        ? withNarrativeStyle(effectivePlan, "skill fallback")
        : effectivePlan;
    const fallbackForThisRound = buildFallbackCompose(params, fallbackPlanForThisRound);
    const systemPrompt = buildComposerSystemPrompt(routing.maxTokens, effectivePlan);
    const userPrompt = buildComposerUserPrompt(params, effectivePlan);
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
        const errorSummary = [plannerError, parsed.error].filter(Boolean).join(" | ");
        if (allowFallback) {
          fallbackErrors.push(`${provider.name}:${errorSummary}`);
          continue;
        }
        return {
          markdown: fallbackForThisRound.markdown,
          agenticUsed: false,
          usedKnowledge: fallbackForThisRound.usedKnowledge,
          error: errorSummary,
        };
      }
      if (parsed.markdown === "No Content") {
        return { markdown: "No Content", agenticUsed: true, usedKnowledge: [] };
      }
      if (effectivePlan.responseStyle === "skill" && !validateSkillMarkdown(parsed.markdown)) {
        if (allowFallback) {
          fallbackErrors.push(`${provider.name}:COMPOSER_SKILL_SECTION_MISSING`);
          continue;
        }
        return {
          markdown: fallbackForThisRound.markdown,
          agenticUsed: false,
          usedKnowledge: fallbackForThisRound.usedKnowledge,
          error: [plannerError, "COMPOSER_SKILL_SECTION_MISSING"].filter(Boolean).join(" | "),
        };
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
        const errorSummary = [plannerError, `CONTEXT_RESPONSE_COMPOSE_FAILED: ${message}`]
          .filter(Boolean)
          .join(" | ");
        fallbackErrors.push(`${provider.name}:${errorSummary}`);
        continue;
      }
      return {
        markdown: fallbackForThisRound.markdown,
        agenticUsed: false,
        usedKnowledge: fallbackForThisRound.usedKnowledge,
        error: [plannerError, `CONTEXT_RESPONSE_COMPOSE_FAILED: ${message}`]
          .filter(Boolean)
          .join(" | "),
      };
    }
  }

  if (attempted === 0) {
    return {
      markdown: defaultFallback.markdown,
      agenticUsed: false,
      usedKnowledge: defaultFallback.usedKnowledge,
    };
  }

  if (fallbackErrors.length > 0) {
    return {
      markdown: defaultFallback.markdown,
      agenticUsed: false,
      usedKnowledge: defaultFallback.usedKnowledge,
      error: `CONTEXT_RESPONSE_COMPOSE_FAILED: ${fallbackErrors.join(" | ")}`,
    };
  }

  return {
    markdown: defaultFallback.markdown,
    agenticUsed: false,
    usedKnowledge: defaultFallback.usedKnowledge,
  };
}
