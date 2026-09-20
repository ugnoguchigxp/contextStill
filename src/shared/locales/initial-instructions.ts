import type { SupportedLocale } from "./locale.js";

const initialInstructionsByLocale: Record<SupportedLocale, string[]> = {
  ja: [
    "## 常用ルール",
    "- 常に日本語で返答する。",
    "- まず `context_compile` を呼び、作業の主導線とする。`goal` を必ず渡し、適切な `changeTypes` / `technologies` を指定する。",
    "- workspace taskでは、stable `projectRef`、explicit `repoKey`、またはabsolute `repoPath`のいずれかを`context_compile`へ渡す。identityを推測せず、未指定時はglobal-only identityとして記録される。",
    "- `goal` は達成したい状態を1-3文で具体的に書き、設計書パスや `design.md` などの文書参照は含めない。",
    "- ユーザーに情報を提示する際、それが本当に有用であるかを厳格に評価し、不確実な情報やノイズでコンテキストを圧迫しない。",
    "- 完了報告の前に、`context_compile` の実行回数と `compile_eval` の実行回数を自己申告する。また、各 runId ごとに `compile_eval` を1件以上保存する。ただし、`context_compile` が `No Content` を返した runId には保存しない。",
    "",
    "## 主要MCPツール",
    "- `initial_instructions`: プロジェクト作業開始時に一度だけ、運用ルールと主要フローを読む。",
    "- `context_compile`: 作業前の最小コンテキスト生成（主導線）。",
    "- `compile_eval`: `No Content` 以外の `context_compile` の作業後評価を保存。",
    "",
    "その他の公開ツールは補助機能。通常フローでは主要ツールを優先し、補助ツールは明確に必要な場合だけ使う。",
  ],
  en: [
    "## Operational Rules",
    "- Always respond in Japanese.",
    "- First call `context_compile` as the main baseline of the task. Always provide `goal`, and specify appropriate `changeTypes` / `technologies`.",
    "- For workspace tasks, pass a stable `projectRef`, explicit `repoKey`, or absolute `repoPath` to `context_compile`. Do not infer identity; missing identity is recorded as global-only.",
    "- Keep the `goal` focused on 1-3 specific sentences describing the desired outcome. Do not include path references like `design.md` or implementation plans.",
    "- Strictly evaluate if the presented information to the user is truly useful and specific to avoid context pollution.",
    "- Before announcing completion, self-report the count of `context_compile` and `compile_eval` executions. Record at least one `compile_eval` for each runId in the session, except when `context_compile` returned `No Content`.",
    "",
    "## Primary MCP Tools",
    "- `initial_instructions`: Read operating rules and the primary flow once at the start of project work.",
    "- `context_compile`: Generates the baseline minimal context before working.",
    "- `compile_eval`: Saves post-task evaluation metrics for `context_compile` runs that returned content.",
    "",
    "Other exposed tools are supplemental. Prefer the primary tools in normal workflows and use supplemental tools only when clearly needed.",
  ],
};

export function buildInitialInstructionsText(locale: SupportedLocale): string {
  return initialInstructionsByLocale[locale].join("\n");
}
