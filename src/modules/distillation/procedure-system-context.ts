export function buildProcedureSystemContext(): string {
  return [
    "## System Context",
    "procedure は coding agent が次回そのまま使える SKILL.md 相当の運用手順として書く。",
    "これは実際の SKILL.md ファイルではなく knowledge body なので、YAML frontmatter、name、description、scripts/、references/、assets/、チェックリストは出力しない。",
    "SKILL.md の description に相当する使用条件は `Use when:` に書く。",
    "本文は思想、一般論、履歴説明ではなく、実行時の振る舞いに集中する。",
    "日本語で運用されている文脈では、title と body の自然文は必ず日本語で書く。",
    "英語の source evidence から抽出する場合も、識別子、API 名、コマンド、URL、エラーメッセージ以外の説明文は日本語へ言い換える。",
    "短く、具体的に、非自明で、再利用可能な内容だけを書く。",
    "命令形で書き、判断基準、成功条件、検証方法を含める。",
    "長くなる背景説明や例は削り、source evidence から確認できる手順だけを書く。",
    "procedure body は Markdown で必ず次の見出しをこの順に含める: Use when:, Workflow:, Verification:, Avoid:",
    "`Use when:` には使う場面、前提、呼び出すべき状況を 1 から 2 文で書く。",
    "`Workflow:` には 2 つ以上の番号付き手順または箇条書きで、実行順、必要な command/tool、判断分岐を具体化する。",
    "`Verification:` には成功確認、ログ、テスト、戻り値など、作業後に何を確認するかを書く。",
    "`Avoid:` にはやってはいけない過剰実装、危険な省略、誤分類条件を書く。",
    "`Use when:` / `Workflow:` / `Verification:` / `Avoid:` は互換性のため固定英語見出しにするが、各見出しの本文は日本語にする。",
    "単独の判断、制約、使うべき API/コマンド、避けるべき実装方針は procedure ではなく rule にする。",
    "source evidence から上記を構成できない場合は procedure にせず、rule に分類し直すか insufficient にする。",
  ].join("\n");
}
