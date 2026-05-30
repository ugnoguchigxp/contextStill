import { groupedConfig } from "../../config.js";
import {
  type CoverEvidenceSourceContext,
  applicabilityInstructions,
  procedureBodyInstructions,
} from "./helpers.js";
import type { McpEvidenceToolName } from "./mcp-evidence.service.js";
import { buildCoverEvidenceSearchQuery } from "./search-query.service.js";
import type { CoverEvidenceCandidate, CoverEvidenceReference } from "./types.js";

const MAX_VALUE_ASSESSMENT_SOURCE_CHARS = 1000;

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function compactReferences(references: CoverEvidenceReference[]): Array<{
  kind: CoverEvidenceReference["kind"];
  uri: string;
  locator?: string;
  title?: string;
  evidenceRole: CoverEvidenceReference["evidenceRole"];
}> {
  return references.map((reference) => ({
    kind: reference.kind,
    uri: reference.uri,
    ...(reference.locator ? { locator: reference.locator } : {}),
    ...(reference.title ? { title: reference.title } : {}),
    evidenceRole: reference.evidenceRole,
  }));
}

function compactSourceContext(context: CoverEvidenceSourceContext): {
  targetKind: CoverEvidenceSourceContext["targetKind"];
  sourceUri: string;
  readRanges: CoverEvidenceSourceContext["readRanges"];
  sourceSummary?: string;
} {
  return {
    targetKind: context.targetKind,
    sourceUri: context.sourceUri,
    readRanges: context.readRanges,
    ...(context.sourceSummary ? { sourceSummary: context.sourceSummary } : {}),
  };
}

function compactSourceEvidence(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_ASSESSMENT_SOURCE_CHARS);
}

export function applicabilityBlankResponseReminderLines(
  stage: "web" | "final",
  statuses: string,
): string[] {
  return [
    "直前の応答は空でした。",
    `ラベル付きテキストで返してください: STATUS / STAGE / TYPE / TITLE / BODY / IMPORTANCE / CONFIDENCE / TECHNOLOGIES / CHANGE_TYPES / DOMAINS / REASON（STATUS は ${statuses}、STAGE は ${stage}）。`,
    "TYPE / TITLE / BODY の見出しだけで終わらせず、値まで埋めてください。",
  ];
}

export function externalEvidenceSystemPrompt(): string {
  return [
    "あなたは coverEvidence の外部 evidence 検証器です。",
    "各応答では、現在の段階で求められている形式だけを1つ返してください。",
    "段階1: 検索語だけを1行で返す。形式: `| keyword | keyword | keyword |`。",
    "keyword は1から5個。名詞・固有名詞・API名・機能名・エラー名だけを選び、文章にしないでください。",
    "段階2: search_web の結果を受け取ったら、読む候補番号だけを返す。形式: `2,3,4`。",
    "段階3: fetch_content の本文を受け取ったら、最終判定だけをラベル形式で返す。",
    "最終判定ラベル: STATUS / STAGE / TYPE / TITLE / BODY / IMPORTANCE / CONFIDENCE / TECHNOLOGIES / CHANGE_TYPES / DOMAINS / REASON",
    "STATUS は knowledge_ready|insufficient|duplicate|near_duplicate のいずれかにしてください。",
    ...procedureBodyInstructions(),
    ...applicabilityInstructions(),
    "insufficient の場合は STATUS / STAGE / REASON だけでも構いません。",
    "IMPORTANCE と CONFIDENCE は 0 から 100 目安の数値です。",
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
    `検索語ヒント（必要なら選び直してよい・最大5個）: ${query.searchTerms.join(" | ")}`,
  ].join("\n\n");
}

export function valueAssessmentSystemPrompt(): string {
  /*
   * Previous known-good full prompt, retained as the rollback reference:
   * [
   *   "あなたは coverEvidence の knowledge value 判定器です。",
   *   "候補が次回以降の coding agent に再利用可能な rule/procedure かを判定してください。",
   *   "入力 candidate.type は暫定ヒントです。最終 JSON では type を独立に再分類してください。",
   *   "procedure は順序付き作業、コマンドフロー、検証/復旧/レビューの再利用可能な手順です。",
   *   "rule は持続的な制約・方針・不変条件・意思決定です。",
   *   "手順・運用フロー・レビュー手順を小さな rule に分解して返さないでください。",
   *   ...procedureBodyInstructions(),
   *   ...applicabilityInstructions(),
   *   "候補が source excerpt で支えられるかも検証し、source から支えられない場合は status を insufficient、reason を unsupported_by_source にしてください。",
   *   "importance と confidence は 0 から 100 目安の数値です。未確定なら省略して構いません。",
   *   `importance が ${groupedConfig.distillation.lowImportanceRejectThreshold} 以下なら status は insufficient、reason は low_importance にしてください。`,
   *   "JSON は次の形を基本にしてください。applicability field は任意で、省略しても構いません:",
   *   '{"schemaVersion":1,"status":"knowledge_ready|insufficient","stage":"final","type":"rule|procedure","title":"...","body":"...","importance":80,"confidence":80,"technologies":"...","changeTypes":"...","domains":"...","applicabilityGeneral":false,"references":[],"duplicateRefs":[],"toolEvents":[],"reason":null}',
   *   "insufficient の場合は title/body/type/importance/confidence を省略して構いません。",
   * ].join("\n");
   */
  return [
    "あなたは coverEvidence の knowledge value 判定器です。",
    "candidate が次回以降の coding agent に再利用可能で、source evidence に支えられるかだけを判定してください。",
    "candidate.type はヒントです。必要なら rule/procedure を再分類してください。",
    "rule は持続的な制約・方針・不変条件・意思決定です。単独の判断や禁止事項は rule にしてください。",
    "procedure は順序付き作業、コマンドフロー、検証/復旧/レビュー手順です。2 step 以上の workflow と確認方法が source evidence から言える場合だけ procedure にしてください。",
    "procedure body は Markdown で Use when:, Workflow:, Verification:, Avoid: を含めてください。構成できない場合は rule か insufficient にしてください。",
    "source evidence で支えられない場合は status=insufficient、reason=unsupported_by_source にしてください。",
    `importance が ${groupedConfig.distillation.lowImportanceRejectThreshold} 以下なら status は insufficient、reason は low_importance にしてください。`,
    "knowledge_ready を返す場合、technologies/changeTypes/domains はそれぞれ最低 1 件を必ず返してください。",
    "3カテゴリを埋められない場合は knowledge_ready にせず status=insufficient、reason=applies_to_categories_required を返してください。",
    "repoPath/repoKey/applicabilityGeneral は source/candidate で明示できる場合だけ追加してください。",
    "JSON だけを返してください。基本形:",
    '{"schemaVersion":1,"status":"knowledge_ready|insufficient","stage":"final","type":"rule|procedure","title":"...","body":"...","importance":80,"confidence":80,"technologies":"...","changeTypes":"...","domains":"...","applicabilityGeneral":false,"references":[],"duplicateRefs":[],"toolEvents":[],"reason":null}',
    "insufficient の場合は status/stage/reason だけでも構いません。",
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
    compactJson(params.candidate),
    "source references:",
    compactJson(compactReferences(params.sourceReferences)),
    "system/source metadata:",
    compactJson(compactSourceContext(params.sourceContext)),
    "source evidence summary/excerpt:",
    compactSourceEvidence(params.sourceContentExcerpt),
  ].join("\n\n");
}

export function applicabilityRefinementSystemPrompt(): string {
  return [
    "あなたは coverEvidence の applicability 補完器です。",
    "目的は technologies / changeTypes / domains の3カテゴリを埋めることです。",
    "source evidence と candidate から根拠のある値だけを返してください。",
    "knowledge_ready を返す場合、3カテゴリそれぞれ最低 1 件を必ず返してください。",
    "推測で埋められない場合は status=insufficient と reason=applies_to_categories_required を返してください。",
    "JSON だけを返してください。",
    '{"schemaVersion":1,"status":"knowledge_ready|insufficient","stage":"final","type":"rule|procedure","title":"...","body":"...","technologies":"...","changeTypes":"...","domains":"...","reason":null}',
  ].join("\n");
}

export function applicabilityRefinementUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  sourceContext: CoverEvidenceSourceContext;
}): string {
  return [
    "以下の candidate について、3カテゴリを補完してください。",
    "candidate:",
    compactJson(params.candidate),
    "source references:",
    compactJson(compactReferences(params.sourceReferences)),
    "system/source metadata:",
    compactJson(compactSourceContext(params.sourceContext)),
    "source evidence summary/excerpt:",
    compactSourceEvidence(params.sourceContentExcerpt),
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
