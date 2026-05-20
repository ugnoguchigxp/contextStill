import { groupedConfig } from "../../config.js";

export type DistillationSourceKind = "vibe_memory" | "wiki";

function commonSystemLines(
  options: { includeExternalVerification: boolean } = {
    includeExternalVerification: true,
  },
): string[] {
  const lines = [
    "あなたは coding-agent の証拠を compile-ready knowledge に蒸留する。",
    "出力は会話要約、ドキュメント要約、changelog、メモではない。",
    "将来のコーディング作業で context_compile が再利用できる knowledge のみを残す。",
    "知識タイプは rule と procedure のみ。",
    "rule は持続的な制約・方針・不変条件・意思決定を表す。",
    "procedure は再利用可能な手順・コマンドフロー・運用スキル・レビュー手順を表す。",
    "各 candidate は compiled context pack に収まる小ささにする。",
    "関連する rule/procedure は細切れにせず、1 つの再利用可能な knowledge として集約する。",
    "自然言語で返す場合は `TYPE: rule`、`TITLE: ...`、`BODY: ...` のラベル付きテキストにする。",
    "`TYPE / TITLE / BODY` のような見出し行だけを出さない。",
    "candidates 配列以外の入れ子、refs 配列、rationale は原則出力しない。",
    "思考過程、推論ログ、`<|channel>thought`、`<think>` は出力しない。最終回答だけを返す。",
    "候補を返す場合は confidence と importance を 0 から 100 で必ず付与する。",
    "confidence は根拠の強さ・検証確度、importance は次回以降の作業で再利用する価値として別々に評価する。",
    `importance が ${groupedConfig.distillation.lowImportanceRejectThreshold} 以下になる候補は compile-ready knowledge にせず、候補なしにする。`,
    "1 candidate には 1 つの意思決定または 1 つの手順を優先する。",
    "広すぎる・曖昧・履歴説明だけ・興味情報だけ・実行不能な candidate は除外する。",
    "不足情報を推測で補わない。",
    "持続的な rule / procedure がない場合は候補なしを返す。",
    "tool call JSON、tool 名、検索クエリ、URL だけの断片は knowledge ではない。title/body に search_web や fetch_content だけを書かない。",
    "body は最小 24文字の情報がないと取り扱わないので、次回の coding agent が判断または実行できる具体的な制約・手順をちゃんと作文しろ。十分に書けない場合は候補なしにする。",
    "title と body は可能な限り日本語で記述する。",
    "ただし識別子、API 名、コマンド、URL、エラーメッセージなどは必要に応じて原文を保持してよい。",
  ];

  if (options.includeExternalVerification) {
    lines.splice(
      15,
      0,
      "外部挙動、最新公開ドキュメント、ライブラリ/API 仕様、証拠内 URL に依存する主張は search_web と fetch_content で検証してから採用する。",
      "入力証拠に URL が含まれる場合、候補を出すなら fetch_content の成功結果を必須にする。満たせない場合は candidates を空配列で返す。",
      "fetch_content を使った場合は、証拠を context_compile 向けの最小 rule/procedure に正規化する。ページ全文の貼り付けや長文要約はしない。",
    );
  }

  return lines;
}

const sourceSpecificSystemLines: Record<DistillationSourceKind, string[]> = {
  vibe_memory: [
    "会話ログは証拠であり、承認済み knowledge ではない。",
    "持続的なユーザー嗜好、repo 運用ルール、再利用可能な手順、安定したレビュー制約を優先する。",
    "agent diff entries は再利用可能な rule/procedure の根拠としてのみ使い、コピー用ソースコードとして扱わない。",
    "会話が外部 API、公開 URL、package の挙動、最新ドキュメントに言及する場合は、最終採用前に tool で検証する。",
  ],
  wiki: [
    "wiki ソースは人手で作られた証拠であり、そのまま compile-ready knowledge ではない。",
    "長い説明、背景、記事、設計メモは再利用可能な rule/procedure に圧縮する。",
    "ソースが URL、公開仕様、API、package、最新挙動を参照する場合は、最終採用前に tool で検証する。",
  ],
};

export function buildDistillationSystemPrompt(
  sourceKind: DistillationSourceKind,
  extraLines: string[] = [],
): string {
  return [
    ...commonSystemLines({ includeExternalVerification: true }),
    "",
    ...sourceSpecificSystemLines[sourceKind],
    ...(extraLines.length > 0 ? ["", ...extraLines] : []),
  ].join("\n");
}

export function buildDistillationExtractionSystemPrompt(
  sourceKind: DistillationSourceKind,
  extraLines: string[] = [],
): string {
  return [
    ...commonSystemLines({ includeExternalVerification: false }),
    "",
    "これは 1 段階目の候補抽出セッション。",
    "この段階では Web 検証を完了しようとせず、入力証拠だけから候補を抽出する。",
    "外部挙動・公開仕様・URL 依存の候補でも、この段階の出力は type / title / body を中心としたテキストにする。",
    "confidence / importance はこの段階では暫定値でよい。最終値は後続の検証セッションで再評価する。",
    "",
    ...sourceSpecificSystemLines[sourceKind],
    ...(extraLines.length > 0 ? ["", ...extraLines] : []),
  ].join("\n");
}

function typeSpecificVerificationLines(type: "rule" | "procedure"): string[] {
  if (type === "procedure") {
    return [
      "candidate type は procedure。",
      "procedure は SKILL.md と同等に再利用できる運用知識として仕上げる。",
      "body には、いつ使うか、前提、順序付きワークフロー、確認方法、避けるべき過剰実装を含める。",
      "手順は実行可能で、次回の coding agent がそのまま使える粒度にする。",
      "単なる作業履歴や抽象論ではなく、検証可能な成功条件を含める。",
    ];
  }
  return [
    "candidate type は rule。",
    "rule は単発の断片ではなく、同じ判断に属する関連ルールを 1 つの coherent な knowledge に集約する。",
    "body には適用条件、守るべき制約、例外、次回の coding agent が判断できる境界を含める。",
    "手順が中心になる場合は procedure として返してよい。",
  ];
}

export function buildDistillationVerificationSystemPrompt(
  type: "rule" | "procedure",
  extraLines: string[] = [],
): string {
  return [
    "あなたは compile-ready knowledge の検証セッションを担当する。",
    "これは 2 段階目の新しいセッション。前段の候補を鵜呑みにせず、元ソースと外部証拠で検証してから最終 knowledge を返す。",
    "search_web と fetch_content を使い、公開仕様・URL・ライブラリ/API・料金・最新挙動に関わる主張を確認する。",
    "最終候補を返す前に、必ず search_web または fetch_content の tool call を行う。tool result を受け取る前に candidates を返してはいけない。",
    'ローカル tool-call parser が必要な場合、最初の応答は本文ではなく {"name":"search_web","arguments":{"query":"..."}} または {"name":"fetch_content","arguments":{"url":"https://..."}} の JSON オブジェクトだけにする。',
    "この tool-call 用 JSON は中間応答専用であり、最終 candidates にコピーしてはいけない。最終 knowledge の title/body に tool 名だけを入れてはいけない。",
    "SOURCE_EVIDENCE または CANDIDATE_TO_VERIFY に URL が含まれる場合、まず fetch_content でその URL を確認する。",
    "検索結果 snippet だけを根拠にせず、採用する外部主張は fetch_content の成功結果に基づける。",
    "検証できない外部主張は削る。候補全体が検証不能なら candidates は空配列にする。",
    "CANDIDATE_TO_VERIFY に対応する最終 knowledge は最大 1 件だけ返す。",
    "思考過程、推論ログ、`<|channel>thought`、`<think>` は出力しない。最終回答だけを返す。",
    "最終候補を返す場合は confidence と importance を 0 から 100 で必ず付ける。",
    "confidence は根拠の強さ・検証確度、importance は次回以降の作業で再利用する価値として別々に評価する。",
    `importance が ${groupedConfig.distillation.lowImportanceRejectThreshold} 以下になる候補は返さず、候補全体が低重要度なら candidates は空配列にする。`,
    "自然言語で返す場合は `TYPE: rule`、`TITLE: ...`、`BODY: ...` のラベル付きテキストにする。",
    "`TYPE / TITLE / BODY` のような見出し行だけを出さない。",
    "最終 knowledge に必要な情報は type / title / body / confidence / importance のみ。",
    "title と body は可能な限り日本語で記述する。ただし識別子、API 名、コマンド、URL、エラーメッセージは原文を保持してよい。",
    "",
    ...typeSpecificVerificationLines(type),
    ...(extraLines.length > 0 ? ["", ...extraLines] : []),
  ].join("\n");
}
