# Finalize 匿名化 Distillation 実装計画

> 状態: plan draft
> 作成日: 2026-06-20
> 最終更新: 2026-06-20

## 目的

この文書は、finalize 段階で保存される draft knowledge からプロジェクト固有情報を減らし、機密保持と再利用性を同時に高めるための実装計画である。

中心方針は、finalize を広い再判定ステージにはしないことである。finalize は coverEvidence の結果を受け取り、保存直前に匿名化、保存前説明、保守的整形、procedure 再構成補助を行う薄い最終ゲートとして扱う。

## 目標状態

- draft knowledge の `title` / `body` は、プロジェクト名、repo 名、絶対パス、内部 URL、顧客名、ブランチ名、チケット ID などを直接含まない。
- 匿名化後の knowledge は、特定プロジェクトに閉じない rule / procedure として再利用しやすい。
- 保存前に、なぜ保存または拒否されたかを短い構造化 summary として metadata / audit へ残せる。
- 安価な LLM は匿名化済みテキストだけを扱い、保存可否の主判断や根拠再判定を担当しない。
- procedure 候補は、既存本文から `Use when:` / `Workflow:` / `Verification:` / `Avoid:` へ再構成できる場合だけ補助される。
- 既存の deterministic validator を通過しない候補は保存されない。

## 非目標

- finalize で active 昇格すること。
- finalize で外部 Web 検索や source support 判定をやり直すこと。
- finalize で duplicate 探索、重要度再採点、広い rule/procedure 再分類を行うこと。
- 安価な LLM に生の source evidence、内部パス、プロジェクト固有 metadata を広く渡すこと。
- 匿名化前の固有情報を compile 対象の knowledge 本文へ残すこと。
- 初期実装で完全な固有表現認識を目指すこと。

## 現状評価

現行 finalize は、coverEvidence の `knowledge_ready` 結果を受け取り、低重要度、rule/procedure 品質、applicability、landscape approval、embedding、source link を確認して draft knowledge を保存する。

既にある責務:

| 領域 | 現状 | 扱い |
|---|---|---|
| 保存可否 | `knowledge_ready`、重要度、品質 gate、applicability を確認 | 維持する |
| procedure 品質 | skill-like body でない場合に demote / reject | 維持し、補助後に再実行する |
| embedding | 保存前に必須 | 維持する |
| source link | resolvable source fragment へ link | 維持する |
| metadata | coverEvidence refs / target context / tool events を保存 | 通常表示用と origin 用の分離を追加する |
| secret redaction | API key / token などの秘匿値 redaction は既存 utility がある | project anonymization とは別レイヤとして再利用する |

不足しているのは、secret ではないが公開・共有したくない project-local identifier を、knowledge 本文と通常 metadata から減らす保存前レイヤである。

## 設計方針

### 1. Secret Redaction と Project Anonymization を分ける

`secret redaction` は token、API key、password、private key などを削除する。

`project anonymization` は、次のような識別子を再利用可能な一般表現へ置換する。

| 入力例の種類 | 置換方針 |
|---|---|
| project / product / repo 名 | `the project`、`the application`、`the repository` |
| absolute path | `the workspace`、`the affected file`、`the affected module` |
| user home / organization path | `the local workspace` |
| internal URL / host | `the internal service`、`the private endpoint` |
| branch / ticket / PR identifier | `the working branch`、`the issue`、`the change request` |
| customer / tenant / environment 名 | `the customer`、`the tenant`、`the environment` |
| source target key | 通常 metadata では abstract label、origin metadata では restricted 扱い |

匿名化は「意味を保つ置換」であり、情報を要約して消す処理ではない。候補の再利用に必要な一般概念は残す。

### 2. 後続 LLM は匿名化済み入力だけを扱う

finalize に LLM 補助を入れる場合、入力順序は固定する。

1. deterministic secret redaction
2. deterministic project anonymization
3. cheap LLM による保存前説明
4. cheap LLM による保守的整形
5. cheap LLM による procedure 再構成補助
6. deterministic validators
7. embedding
8. draft storage

LLM には匿名化前の `sourceDocumentUri`、`targetKey`、raw references、absolute path、internal URL を渡さない。必要な場合は category と abstract label だけを渡す。

### 3. 通常 metadata と origin metadata を分ける

draft knowledge には、compile / search / UI で通常表示してよい metadata と、debug / audit / re-link に必要な origin metadata が混在している。

初期実装では次の分離を行う。

| bucket | 用途 | 取り扱い |
|---|---|---|
| `metadata.finalizeSummary` | 保存理由、拒否理由、変換内容の説明 | 匿名化済み |
| `metadata.anonymization` | 置換件数、置換種別、バージョン | 匿名化済み |
| `metadata.references` | 通常レビュー用 references | URI / locator を匿名化または abstract 化 |
| `metadata.origin` | coverEvidenceResultId、sourceDocumentUri、targetKey など | restricted 扱い。compile 本文や通常表示には出さない |

既存互換のため、すぐに既存 field を削除しない。最初は新 bucket を追加し、通常 read path が匿名化済み field を優先するよう段階導入する。

## 実装 Milestone

### M0: Contract とテスト fixture

目的: 匿名化の期待値を先に固定する。

作業:

- `FinalizeAnonymizationInput` / `FinalizeAnonymizationResult` の service contract を定義する。
- project identifier、absolute path、internal URL、branch、ticket、customer-like token を含む fixture を作る。
- redaction と anonymization の違いをテストで固定する。
- 「匿名化後も rule/procedure の意味が残る」期待値を snapshot ではなく explicit assertion で書く。

検証:

- secret token は既存 placeholder に置換される。
- project-local identifier は generic label に置換される。
- generic technical terms、public package names、一般的な file role は過剰に消えない。

### M1: Deterministic anonymizer

目的: LLM を使わず、明らかな固有情報を保存前に置換する。

作業:

- `src/modules/finalizeDistille/anonymization.service.ts` 相当を追加する。
- `title` / `body` / `references` / selected metadata を対象にする。
- 置換結果と `replacements` summary を返す。
- 既存の secret redaction utility を先に通し、その後 project anonymization を通す。
- `runFinalizeDistille` の保存直前に匿名化候補を作る。

検証:

- `upsertKnowledgeFromSource` に渡る `title` / `body` が匿名化済みになる。
- embedding text は匿名化済み `title + body` になる。
- source link 用の raw reference 解決は維持される。
- metadata には匿名化 summary が残る。

### M2: Finalize summary

目的: 保存前後の説明責任を metadata / audit に残す。

作業:

- `finalizeSummary` を生成する。
- まず deterministic summary で始める。
- cheap LLM は optional refinement とし、失敗時は deterministic summary に fallback する。
- summary は保存可否を変更しない。

出力例:

```json
{
  "decision": "stored",
  "reason": "source-supported reusable rule with required applicability facets",
  "anonymization": {
    "applied": true,
    "replacementKinds": ["project_name", "absolute_path"]
  },
  "qualityGates": ["importance", "rule_quality", "applicability", "embedding"]
}
```

検証:

- stored / rejected / dry_run の各結果に summary が残る。
- LLM failure で finalize が失敗しない。
- summary に匿名化前 identifier が含まれない。

### M3: Conservative polish

目的: 匿名化済み本文を、意味を変えずに再利用しやすく整える。

作業:

- cheap LLM に渡す入力は匿名化済み `title` / `body` / type / facets のみとする。
- system prompt で次を禁止する。
  - 新しい事実の追加
  - 固有名詞の復元
  - source にない手順の追加
  - importance / confidence / applicability の変更
- LLM 出力後に deterministic validators を再実行する。
- 変更差分が大きい場合は polish を破棄し、匿名化のみの本文を使う。

検証:

- rule body が意味を保ったまま短くなる。
- unsupported な主張が増えない。
- validator rejection 時は polish 前の匿名化済み candidate に fallback する。
- LLM timeout / parse failure でも保存 path は継続できる。

### M4: Procedure restructuring assist

目的: procedure 候補を、既存情報だけで skill-like body に再構成する。

作業:

- 対象は `candidate.type === "procedure"` かつ workflow signal があるものに限定する。
- 匿名化済み body だけを入力にし、`Use when:` / `Workflow:` / `Verification:` / `Avoid:` へ再配置する。
- 不足情報を創作しないよう、各 section に入れられる情報は入力本文由来に限定する。
- 再構成後に既存 `hasSkillLikeProcedureBody` / `assessProcedureQuality` を再実行する。
- 再構成できない場合は既存どおり demote / reject に進む。

検証:

- 2 step 以上の既存手順がある候補は skill-like body へ整形される。
- 1文だけの rule-like procedure は rule demote される。
- 入力にない command、検証、条件が増えない。
- 匿名化前 identifier が再出現しない。

### M5: Read path と UI の匿名化優先

目的: 保存済み metadata の通常表示で origin 情報が漏れないようにする。

作業:

- compile / search / Admin UI が通常 field では匿名化済み title/body/references を使うことを確認する。
- origin metadata を表示する場合は明示的な detail surface に限定する。
- API response で origin を返すかは route ごとに明示する。

検証:

- `context_compile` の出力に absolute path や project-local identifier が混ざらない。
- Admin UI の一覧表示は匿名化済み情報だけを表示する。
- debug detail で必要な origin に戻れる。

## LLM Routing 方針

### cheap LLM に任せてよいこと

- 匿名化済みテキストの短い説明文生成。
- 匿名化済み rule body の表現整理。
- 匿名化済み procedure body の section 再配置。
- 置換後に不自然になった文の軽い修正。

### cheap LLM に任せないこと

- 保存可否の最終判断。
- source support の再判定。
- 外部情報の取得。
- active 昇格。
- 重要度、信頼度、applicability の再採点。
- raw origin metadata の読解。

### fallback

- LLM が失敗した場合、匿名化済み candidate をそのまま使う。
- LLM 出力が validator を通らない場合、LLM 出力を破棄する。
- 匿名化が失敗した場合は保存しない。機密保持を優先する。

## データ保持ポリシー

初期方針:

- knowledge 本文と通常 metadata は匿名化済みにする。
- source link 解決に必要な raw reference は処理中だけ使う。
- origin metadata は restricted bucket に隔離する。
- compile/search の通常 path では restricted bucket を使わない。

未決事項:

- restricted bucket を DB に保存するか、audit/source link だけに寄せるか。
- 既存 knowledge の backfill anonymization を実施するか。
- 匿名化 map を保存するか、replacement summary だけ保存するか。

推奨初期判断:

- M1 では replacement summary のみ保存する。
- raw への復元 map は保存しない。
- source link に必要な既存 ID は残すが、通常 UI と compile には出さない。

## テスト計画

Unit:

- `anonymization.service` の置換テスト。
- secret redaction と project anonymization の順序テスト。
- conservative polish の fallback テスト。
- procedure restructuring の accept / demote / reject テスト。

Domain:

- `runFinalizeDistille` が匿名化済み candidate を保存する。
- existing knowledge path でも source link は維持される。
- embedding failure の既存挙動を壊さない。
- landscape approval gate を壊さない。

MCP / compile:

- `context_compile` に匿名化前 identifier が出ない。
- draft knowledge search の通常 response に restricted origin が出ない。

Security regression:

- API key、token、private key が redaction される。
- absolute path、internal host、repo-local product name が anonymization される。
- LLM prompt payload に raw origin metadata が入らない。

## Rollout

1. M0-M1 を実装し、LLM なしで匿名化保存を安定させる。
2. M2 の deterministic summary を追加する。
3. cheap LLM summary refinement を feature flag で追加する。
4. M3 conservative polish を feature flag で追加する。
5. M4 procedure restructuring を feature flag で追加する。
6. M5 read path / UI の匿名化優先を確認する。
7. 既存 draft knowledge の backfill 可否を別計画で判断する。

## 完了条件

- finalize 経由で新規保存される draft knowledge は、通常本文に project-local identifier を含まない。
- cheap LLM を無効化しても finalize が成立する。
- cheap LLM を有効化しても保存可否の主判断は deterministic gate が担う。
- procedure 再構成補助は、既存 validator を通った場合だけ採用される。
- `bun run verify` または repo 標準 verify gate が成功する。
- 代表 fixture で、匿名化前 identifier が compile output に出ないことを確認できる。
