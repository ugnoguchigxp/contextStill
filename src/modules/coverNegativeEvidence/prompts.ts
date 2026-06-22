export function buildNegativeEvidencePrompt(params: {
  title: string;
  content: string;
}) {
  return `あなたは failure pattern、regression、architecture/security risk を表す review correction candidate（Negative Knowledge）を分析します。
この correction が再利用可能な rule/guardrail として有効なら status='ready'、不十分・誤検知・再利用不能なら該当 status にしてください。

Candidate Title: ${params.title}
Candidate Body:
${params.content}

JSON のキー名、enum 値、タグ、repo path、API 名、コマンド名、エラー名、固有名詞は指定どおり保持してください。
それ以外の distilled と evidence の自然文は必ず日本語で書いてください。入力が英語でも、保存される failure / impact / trigger / fix / verification / decisionSignal の説明文は日本語へ言い換えてください。

次の schema の JSON response だけを返してください:
{
  "status": "ready" | "insufficient" | "false_positive" | "not_reusable",
  "polarity": "negative" | "neutral",
  "intentTags": string[], // "guardrail", "failure_pattern", "regression", "security_risk" などの normalized tags
  "appliesTo": {
    "technologies": string[], // この rule が適用される concrete stack, runtime, library, language
    "changeTypes": string[], // "implementation", "configuration", "testing", "diagnosis" などの concrete change categories
    "domains": string[], // "queue", "security", "database" などの concrete product/engineering domains
    "repoPath": string | null, // 明示されている場合のみ
    "repoKey": string | null, // 明示されている場合のみ
    "general": boolean | null // 意図的に cross-repository な rule の場合だけ true
  },
  "distilled": {
    "failure": string, // 避けるべき失敗・リスクの説明。自然文は日本語。
    "impact": string | null, // 影響。自然文は日本語。
    "trigger": string | null, // このリスクが発生する条件・文脈。自然文は日本語。
    "fix": string | null, // 推奨される回避策・修正方針。自然文は日本語。
    "verification": string | null, // この失敗を確認する方法。自然文は日本語。
    "decisionSignal": string | null // 判断シグナル。自然文は日本語。
  },
  "evidence": string[], // candidate 内の根拠 snippet。自然文は日本語へ要約。
  "originRefs": string[] // origin 由来の references
}

status='ready' の場合、appliesTo.technologies、appliesTo.changeTypes、appliesTo.domains は non-empty で、candidate text または origin context に根拠が必要です。これらの applicability categories を決める根拠が足りない場合は、広いカテゴリを捏造せず status='insufficient' にしてください。
status='ready' の場合、distilled.trigger と distilled.fix は必須です。単なる作業中の注意、局所的なコマンド事故、一回限りの検証メモ、または根拠が1文だけの広範囲 guardrail は ready にせず status='insufficient' または status='not_reusable' にしてください。
appliesTo.general=true は、複数リポジトリ・複数技術で再利用する明示根拠が candidate text にある場合だけ使用してください。迷う場合は general=false として具体的な technologies/changeTypes/domains に閉じてください。
JSON object 1 個だけを返してください。markdown code block syntax は含めないでください。`;
}
