import { groupedConfig } from "../../config.js";
import { buildCoverEvidenceSearchQuery } from "./search-query.service.js";
import type { McpEvidenceToolName } from "./mcp-evidence.service.js";
import {
  applicabilityInstructions,
  procedureBodyInstructions,
  type CoverEvidenceSourceContext,
} from "./helpers.js";
import type { CoverEvidenceCandidate, CoverEvidenceReference } from "./types.js";

export function applicabilityBlankResponseReminderLines(
  stage: "web" | "final",
  statuses: string,
): string[] {
  return [
    "直前の応答は空でした。",
    `次のようなフラット JSON を返してください: {"status":"${statuses}","stage":"${stage}","type":"rule|procedure","title":"...","body":"...","importance":80,"confidence":80,"technologies":"...","changeTypes":"...","domains":"...","applicabilityGeneral":false}`,
    "またはラベル付きテキストを返してください: STATUS / STAGE / TYPE / TITLE / BODY / TECHNOLOGIES / CHANGE_TYPES / DOMAINS / APPLICABILITY_GENERAL / REPO_PATH / REPO_KEY。",
  ];
}

export function externalEvidenceSystemPrompt(): string {
  return [
    "あなたは coverEvidence の外部 evidence 検証器です。",
    "必ず search_web または fetch_content を使ってから、JSON だけを返してください。",
    "入力 candidate.type は暫定ヒントです。最終 JSON では type を独立に再分類してください。",
    "procedure は順序付き作業、コマンドフロー、検証/復旧/レビューの再利用可能な手順です。",
    "rule は持続的な制約・方針・不変条件・意思決定です。",
    "手順・運用フロー・レビュー手順を小さな rule に分解して返さないでください。",
    ...procedureBodyInstructions(),
    ...applicabilityInstructions(),
    "search_web は URL 発見用です。検索結果 snippet だけを最終根拠にしてはいけません。",
    "search_web は最大 1 回だけ使ってください。",
    "search_web の結果を受け取ったら、採用候補の一次ソース URL を 1 から 3 件選び、最終 JSON の前に fetch_content を呼んでください。",
    "fetch_content は最大 3 回まで使ってください。",
    "fetch_content は同じ検証 session で複数回呼んで構いません。失敗した URL があれば、別の有望な URL を fetch_content してください。",
    "候補や source references に URL が含まれる場合は、search_web より先にその URL を fetch_content してください。",
    "search_web を同義の言い換え query で繰り返さないでください。query は短く安定した公式名・API名・概念名を優先してください。",
    "外部主張を採用するなら fetch_content の成功結果に基づけてください。",
    "JSON は次の形を基本にしてください。applicability field は任意で、省略しても構いません:",
    '{"schemaVersion":1,"status":"knowledge_ready|insufficient|duplicate|near_duplicate","stage":"web","type":"rule|procedure","title":"...","body":"...","importance":80,"confidence":80,"technologies":"...","changeTypes":"...","domains":"...","applicabilityGeneral":false,"references":[],"duplicateRefs":[],"toolEvents":[],"reason":null}',
    "importance と confidence は 0 から 100 目安の数値で返してください。整数でなくても構いません。",
  ].join("\n");
}

export function externalEvidenceUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContext: CoverEvidenceSourceContext;
}): string {
  const query = buildCoverEvidenceSearchQuery(`${params.candidate.title} ${params.candidate.body}`);
  return [
    "候補を外部 evidence で検証してください。",
    "候補:",
    JSON.stringify(params.candidate, null, 2),
    "source references:",
    JSON.stringify(params.sourceReferences, null, 2),
    "system/source metadata:",
    JSON.stringify(params.sourceContext, null, 2),
    `推奨検索 query: ${query.query}`,
  ].join("\n\n");
}

export function valueAssessmentSystemPrompt(): string {
  return [
    "あなたは coverEvidence の knowledge value 判定器です。",
    "候補が次回以降の coding agent に再利用可能な rule/procedure かを判定してください。",
    "入力 candidate.type は暫定ヒントです。最終 JSON では type を独立に再分類してください。",
    "procedure は順序付き作業、コマンドフロー、検証/復旧/レビューの再利用可能な手順です。",
    "rule は持続的な制約・方針・不変条件・意思決定です。",
    "手順・運用フロー・レビュー手順を小さな rule に分解して返さないでください。",
    ...procedureBodyInstructions(),
    ...applicabilityInstructions(),
    "候補が source excerpt で支えられるかも検証し、source から支えられない場合は status を insufficient、reason を unsupported_by_source にしてください。",
    "importance と confidence は 0 から 100 目安の数値です。未確定なら省略して構いません。",
    `importance が ${groupedConfig.distillation.lowImportanceRejectThreshold} 以下なら status は insufficient、reason は low_importance にしてください。`,
    "JSON は次の形を基本にしてください。applicability field は任意で、省略しても構いません:",
    '{"schemaVersion":1,"status":"knowledge_ready|insufficient","stage":"final","type":"rule|procedure","title":"...","body":"...","importance":80,"confidence":80,"technologies":"...","changeTypes":"...","domains":"...","applicabilityGeneral":false,"references":[],"duplicateRefs":[],"toolEvents":[],"reason":null}',
    "insufficient の場合は title/body/type/importance/confidence を省略して構いません。",
  ].join("\n");
}

export function valueAssessmentUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  sourceContext: CoverEvidenceSourceContext;
}): string {
  return [
    "候補の value と source support を判定してください。",
    "候補:",
    JSON.stringify(params.candidate, null, 2),
    "source references:",
    JSON.stringify(params.sourceReferences, null, 2),
    "system/source metadata:",
    JSON.stringify(params.sourceContext, null, 2),
    "source excerpt:",
    params.sourceContentExcerpt.slice(0, 6000),
  ].join("\n\n");
}

export function mcpEvidenceSystemPrompt(toolNames: readonly McpEvidenceToolName[]): string {
  return [
    "あなたは coverEvidence の任意 MCP evidence 収集器です。",
    `利用可能な補助 tool は ${toolNames.join(", ")} です。`,
    "候補の公開ライブラリ、フレームワーク、API、リポジトリ仕様に関係する補助 evidence がある場合だけ tool を使ってください。",
    "MCP evidence は補助情報です。web fetch evidence の代替として扱ってはいけません。",
    '最後は {"status":"checked"} の JSON だけを返してください。',
  ].join("\n");
}

export function mcpEvidenceUserPrompt(candidate: CoverEvidenceCandidate): string {
  return [
    "候補に関連する補助 MCP evidence を収集してください。",
    "候補:",
    JSON.stringify(candidate, null, 2),
  ].join("\n\n");
}
