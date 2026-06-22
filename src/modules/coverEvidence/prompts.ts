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

function japaneseKnowledgeInstructions(): string[] {
  return [
    "日本語で運用されている文脈では、knowledge_ready の title と body を日本語で整形することを優先してください。",
    "入力や利用者の文脈が英語の場合は英語のままでも構いません。",
    "コード、コマンド、API名、エラー名、固定見出し（Use when:, Workflow:, Verification:, Avoid:）は原文のまま残して構いません。",
  ];
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
  assessmentSource?: CoverEvidenceSourceContext["assessmentSource"];
  hasPrimaryEvidence?: boolean;
} {
  return {
    targetKind: context.targetKind,
    sourceUri: context.sourceUri,
    readRanges: context.readRanges,
    ...(context.assessmentSource ? { assessmentSource: context.assessmentSource } : {}),
    ...(context.hasPrimaryEvidence !== undefined
      ? { hasPrimaryEvidence: context.hasPrimaryEvidence }
      : {}),
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
    "出力はこの形だけです。",
    "1行目: タイトル",
    "2行目から最終行の前まで: 本文",
    `最終行: TYPE / rule|procedure / STATUS / ${statuses} / STAGE / ${stage} / IMPORTANCE / 0-100 / CONFIDENCE / 0-100 / TECHNOLOGIES / ... / CHANGE_TYPES / ... / DOMAINS / ... / REASON / ...`,
    "本文では空白や / を自由に使ってください。/ 区切りとして読むのは最終行だけです。",
  ];
}

export function externalEvidenceSearchQuerySystemPrompt(): string {
  return [
    "外部 evidence 検索用の検索語だけを選んでください。",
    "出力は1行だけです。",
    "形式: `| keyword |` または `| keyword | keyword |`",
    "keyword は1個以上から3個以下です。1個で十分なら1個だけ返してください。",
    "名詞・固有名詞・API名・機能名・エラー名だけを選び、文章にしないでください。",
    "Use when / Workflow / Verification / Avoid / rule / procedure などの見出し語は検索語にしないでください。",
    "数合わせで一般語を足さないでください。",
  ].join("\n");
}

export function externalEvidenceSearchQueryUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
}): string {
  const querySource = [
    params.candidate.title,
    ...(params.candidate.technologies ?? []),
    ...(params.candidate.changeTypes ?? []),
    ...(params.candidate.domains ?? []),
  ].join(" ");
  const query = buildCoverEvidenceSearchQuery(querySource || params.candidate.title);
  return [
    `title: ${params.candidate.title}`,
    `body: ${params.candidate.body.slice(0, 500)}`,
    `検索語ヒント（必要なら選び直してよい・最大3個）: ${query.searchTerms.join(" | ")}`,
  ].join("\n\n");
}

export function externalEvidenceFetchSelectionSystemPrompt(maxFetchCount = 3): string {
  return [
    "search_web の結果から、fetch_content で読む候補番号だけを選んでください。",
    "出力は番号だけです。",
    "形式: `2,3,4`",
    `1から${maxFetchCount}件まで選んでください。`,
    "説明、URL、JSON、ラベルは返さないでください。",
  ].join("\n");
}

export function externalEvidenceFetchSelectionUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  searchQuery: string;
  searchResults: string;
}): string {
  return [
    `title: ${params.candidate.title}`,
    `body: ${params.candidate.body.slice(0, 600)}`,
    `search query: ${params.searchQuery}`,
    "search results:",
    params.searchResults,
  ].join("\n\n");
}

export function externalEvidenceFinalSystemPrompt(webEvidenceTokenBudget = 15_000): string {
  return [
    "source evidence と fetch_content evidence から、coverEvidence の最終判定を返してください。",
    "source evidence は候補の直接根拠です。fetch_content evidence は公開Webの補助根拠です。",
    `fetch_content evidence は最大約 ${webEvidenceTokenBudget} token まで渡されます。複数ソースの本文を比較して、不足情報を補ってください。`,
    "内部実装、repo運用、coding agent 作業手順は公開Webだけでは直接検証できない場合があります。その場合、source evidence が十分なら knowledge_ready にしてください。",
    "knowledge_ready のタイトルと本文は、汎用的に使える知識として体裁を整えてください。",
    "search snippet は根拠にしないでください。",
    ...japaneseKnowledgeInstructions(),
    "最終判定はJSONではなくラベル形式だけで返してください。",
    "出力はこの形だけです。",
    "1行目: タイトル",
    "2行目から最終行の前まで: 本文",
    "最終行: TYPE / rule|procedure / STATUS / knowledge_ready|insufficient|duplicate|near_duplicate / STAGE / web / IMPORTANCE / 0-100 / CONFIDENCE / 0-100 / TECHNOLOGIES / ... / CHANGE_TYPES / ... / DOMAINS / ... / REASON / ...",
    "本文では空白や / を自由に使ってください。/ 区切りとして読むのは最終行だけです。",
    "STATUS は knowledge_ready|insufficient|duplicate|near_duplicate のいずれかです。STAGE は web 固定です。",
    "TYPE は rule|procedure の小文字だけです。",
    "insufficient の場合も同じ形式で返し、本文が不要なら短い理由を書いてください。",
    "IMPORTANCE と CONFIDENCE は 0 から 100 目安の数値です。",
    ...procedureBodyInstructions(),
    ...applicabilityInstructions(),
  ].join("\n");
}

export function externalEvidenceFinalUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContext: CoverEvidenceSourceContext;
  sourceEvidence: string;
  searchQuery: string;
  fetchedEvidence: string;
}): string {
  return [
    "候補:",
    JSON.stringify(params.candidate, null, 2),
    "source references:",
    JSON.stringify(params.sourceReferences, null, 2),
    "system/source metadata:",
    JSON.stringify(params.sourceContext, null, 2),
    "source evidence:",
    compactSourceEvidence(params.sourceEvidence),
    `search query: ${params.searchQuery}`,
    "fetch_content evidence:",
    params.fetchedEvidence,
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
    ...japaneseKnowledgeInstructions(),
    "knowledge_ready の title/body は、汎用的に使える知識として体裁を整えてください。",
    "source evidence で支えられない場合は status=insufficient、reason=unsupported_by_source にしてください。",
    `importance が ${groupedConfig.distillation.lowImportanceRejectThreshold} 以下なら status は insufficient、reason は low_importance にしてください。`,
    "knowledge_ready を返す場合、technologies/changeTypes/domains はそれぞれ最低 1 件を必ず返してください。",
    "technologies/changeTypes/domains の値は、可能な限り lowercase kebab-case の ASCII tag で返してください（例: release-management, feature-flag）。",
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
    "source evidence excerpt:",
    compactSourceEvidence(params.sourceContentExcerpt),
  ].join("\n\n");
}

export function applicabilityRefinementSystemPrompt(): string {
  return [
    "あなたは coverEvidence の applicability 補完器です。",
    "目的は technologies / changeTypes / domains の3カテゴリを埋めることです。",
    "source evidence と candidate から根拠のある値だけを返してください。",
    ...japaneseKnowledgeInstructions(),
    "title/body を返す場合は、汎用的に使える知識として体裁を整えてください。",
    "knowledge_ready を返す場合、3カテゴリそれぞれ最低 1 件を必ず返してください。",
    "technologies/changeTypes/domains の値は、可能な限り lowercase kebab-case の ASCII tag で返してください（例: release-management, feature-flag）。",
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
