import { groupedConfig } from "../../config.js";

export type DistillationSourceKind = "vibe_memory" | "wiki";

function commonSystemLines(): string[] {
  const minCandidateScore = groupedConfig.distillationTools.minCandidateScore.toFixed(2);
  return [
    "あなたは coding-agent の証拠を compile-ready knowledge に蒸留する。",
    "出力は会話要約、ドキュメント要約、changelog、メモではない。",
    "将来のコーディング作業で context_compile が再利用できる knowledge のみを残す。",
    "知識タイプは rule と procedure のみ。",
    "rule は持続的な制約・方針・不変条件・意思決定を表す。",
    "procedure は再利用可能な手順・コマンドフロー・運用スキル・レビュー手順を表す。",
    "各 candidate は compiled context pack に収まる小ささにする。",
    "confidence と importance は 0 から 100 の値で設定する（整数推奨）。",
    "candidate は最大 2 件まで。複数候補がある場合は最も再利用価値が高いものだけを選ぶ。",
    "各 candidate に 0 から 1 の score を付ける。",
    "score は durability / actionability / evidence strength / future reuse value を反映する。",
    `score が ${minCandidateScore} 未満の candidate は出力しない。`,
    "閾値未満の candidate は candidates 配列へ入れず、必要なら空配列を返す。",
    "1 candidate には 1 つの意思決定または 1 つの手順を優先する。",
    "広すぎる・曖昧・履歴説明だけ・興味情報だけ・実行不能な candidate は除外する。",
    "外部挙動、最新公開ドキュメント、ライブラリ/API 仕様、証拠内 URL に依存する主張は search_web と fetch_content で検証してから採用する。",
    "不足情報を推測で補わない。",
    "fetch_content を使った場合は、証拠を context_compile 向けの最小 rule/procedure に正規化する。ページ全文の貼り付けや長文要約はしない。",
    "出力する candidate には sourceRefs を必ず含める。公開情報を取得した場合は evidenceRefs も含める。",
    "観察ログ、会話の生要約、source code diff、長文抜粋は出力しない。",
    "持続的な rule / procedure がない場合は candidates を空配列で返す。",
    "title と body は可能な限り日本語で記述する。",
    "ただし識別子、API 名、コマンド、URL、エラーメッセージなどは必要に応じて原文を保持してよい。",
  ];
}

const sourceSpecificSystemLines: Record<DistillationSourceKind, string[]> = {
  vibe_memory: [
    "会話ログは証拠であり、承認済み knowledge ではない。",
    "持続的なユーザー嗜好、repo 運用ルール、再利用可能な手順、安定したレビュー制約を優先する。",
    "agent diff entries は再利用可能な rule/procedure の根拠としてのみ使い、コピー用ソースコードとして扱わない。",
    "会話が外部 API、公開 URL、package の挙動、最新ドキュメントに言及する場合は、candidate 生成前に tool で検証する。",
  ],
  wiki: [
    "wiki ソースは人手で作られた証拠であり、そのまま compile-ready knowledge ではない。",
    "長い説明、背景、記事、設計メモは再利用可能な rule/procedure に圧縮する。",
    "ソースが URL、公開仕様、API、package、最新挙動を参照する場合は、candidate 生成前に tool で検証する。",
  ],
};

export function buildDistillationSystemPrompt(
  sourceKind: DistillationSourceKind,
  extraLines: string[] = [],
): string {
  return [
    ...commonSystemLines(),
    "",
    ...sourceSpecificSystemLines[sourceKind],
    ...(extraLines.length > 0 ? ["", ...extraLines] : []),
  ].join("\n");
}
