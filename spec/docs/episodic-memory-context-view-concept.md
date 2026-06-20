# Episodic Memory Context View Concept

> 状態: concept draft
> 作成日: 2026-06-20
> 関連: [Local-First SQLite And Tauri Concept](local-first-sqlite-tauri-concept.md)

## 目的

この文書は、context-still で Episode 記憶を `context_compile` と `context_decision` の有効な情報ソースにするためのコンセプトを整理する。

中心方針は、raw log をそのまま context に入れるのではなく、普段参照する `EpisodeCard` と、必要時に詳細へ戻る `Ref` を分けることである。

```text
Audit log / full trace
  -> EpisodeCard / compressed CONTEXT
  -> context_compile / context_decision

EpisodeCard で根拠不足
  -> Ref
  -> selected raw log / trace / event / diff
```

これは実装計画ではなく、将来実装の判断基準になる概念文書である。

## 背景

context-still の主軸は、保存された知識を使って次を行うことである。

- 要件に合わせた context 生成としての `context_compile`
- 現在のタスクをどう進めるべきかの判断としての `context_decision`

Episode 記憶は、この2つに対して有効な情報ソースになり得る。ただし、単なる作業ログや自然言語要約だけでは弱い。

有効なのは、過去の出来事が「現在の状況に条件付きで再利用できる事例」として扱える場合である。

```text
Episode = 過去の出来事
Useful Episode = 適用条件つきの過去事例
```

## 中核モデル

### Audit Log

Audit log は source of truth である。

保存対象:

- tool call
- tool result
- task event
- decision point
- trace
- error
- file diff reference
- verification result
- user feedback

Audit log は原則として通常の LLM context に直接入れない。情報量が大きく、人間にも LLM にも可視性が低いためである。

### EpisodeCard

EpisodeCard は、普段 `compile` と `decision` が参照する作業ビューである。

目的:

- 人間が読める
- LLM context に入れても軽い
- 過去事例として比較できる
- 必要時に元証拠へ戻れる

最小 shape:

```text
title
situation
observations
action
outcome
lesson
applicability
anti_applicability
confidence
refs
```

EpisodeCard は要約ではあるが、source of truth ではない。各主張は `refs` で検証可能でなければならない。

### Ref

Ref は、EpisodeCard から元証拠へ戻るための参照経路である。

候補:

- run id
- event id
- trace id
- audit log id
- log range
- file path
- commit hash
- source uri
- query hint
- content hash

Ref の役割は本文を増やすことではなく、drill down の入口を提供することである。

```text
EpisodeCard is for reasoning.
Ref is for verification.
Raw log is source of truth.
```

### Distilled Knowledge

複数の EpisodeCard から、再利用可能な知識を作る。

```text
Audit log
  -> EpisodeCard
  -> Pattern
  -> Rule / Procedure
```

単発 Episode は経験サンプルであり、Rule ではない。複数 Episode で繰り返し現れる条件、失敗、成功手順だけを Rule / Procedure に昇格させる。

## compile での使い方

`context_compile` では、EpisodeCard を「今回の作業地図を補正する経験情報」として使う。

主な用途:

- 似た過去事例を提示する
- 先に見るべき証拠を示す
- ありがちな失敗を警告する
- 有効だった手順を短く示す
- 適用してはいけない条件を示す

compile は通常、EpisodeCard だけを受け取る。Ref の詳細は、Card の根拠が不足している場合だけ取得する。

```text
current task
  -> task signature
  -> relevant EpisodeCards
  -> compact context pack
```

compile は広めに候補を拾ってよい。ただし、最終出力には現在 task に適用可能なものだけを残す。

## decision での使い方

`context_decision` では、EpisodeCard を「判断の適用条件を確認する材料」として使う。

避けるべき使い方:

```text
過去に A で成功した
  -> 今回も A を選ぶ
```

使うべき形:

```text
過去 Episode A は今回に似ている
  -> A が成功した条件は今回も満たされているか
  -> A が失敗した条件は今回も存在するか
  -> Ref で根拠確認が必要か
  -> 進む / 調査する / 戻す / 保留する
```

decision は compile より厳しく絞る。判断根拠にするには、`applicability` と `anti_applicability` が現在状況に対して説明できなければならない。

## 似た Episode の検出

似た Episode は単一検索では検出しない。

hybrid retrieval を使う。

```text
1. current task から task signature を作る
2. vector search で意味的に近い EpisodeCard を拾う
3. full-text search で exact signals を拾う
4. structured metadata で絞る
5. applicability / anti_applicability で rerank する
6. 上位 EpisodeCard だけを context に入れる
7. 必要なら Ref で詳細へ drill down する
```

task signature の要素:

- goal
- domains
- technologies
- changeTypes
- repo または project boundary
- tools
- error codes
- touched files
- user constraints
- outcome requirements

各検索 lane の役割:

| Lane | 役割 |
|---|---|
| vector search | 意味的に近い過去事例を拾う |
| full-text search | error code、tool name、file path、固有名詞を拾う |
| metadata filter | domain、technology、changeType、repo、outcome を絞る |
| rerank | 適用条件、信頼度、根拠、鮮度で並べ替える |

重要な境界:

```text
似ているか = retrieval の仕事
使ってよいか = applicability / decision の仕事
```

vector similarity は適用可能性ではない。全文一致も適用可能性ではない。

## CONTEXT 圧縮との関係

Headroom の CCR 的な考え方と同じく、通常 context は圧縮 view を使い、必要時だけ原本を retrieve する構造が合う。

ただし context-still では、短期 cache ではなく長期記憶として扱うため、次の違いを持たせる。

| Layer | 役割 | 永続性 |
|---|---|---|
| Audit log | 原本、監査、復元 | retention policy に従って保存 |
| EpisodeCard | 通常参照する compressed CONTEXT | 再生成可能だが保存してよい |
| Ref | 原本への検証経路 | stable id として保存 |
| Rule / Procedure | 蒸留された再利用知識 | durable Knowledge |

圧縮 CONTEXT は唯一の真実ではない。常に Ref 経由で検証可能である必要がある。

## 有効になる条件

EpisodeCard は次の条件を満たすほど有効になる。

- 現在 task と `domains` / `technologies` / `changeTypes` が近い
- `applicability` が明示されている
- `anti_applicability` が明示されている
- 成功または失敗の outcome が分かる
- 判断に効いた evidence がある
- Ref で元証拠に戻れる
- confidence がある

特に decision では、条件が曖昧な Episode を強い根拠にしてはいけない。

## ノイズになる条件

次の Episode は compile / decision でノイズになりやすい。

- ただの時系列ログ
- ただの自然言語要約
- 適用条件がない
- outcome がない
- Ref がない
- UI 表示用イベントと判断用 evidence が混ざっている
- repo や technology の境界が違う
- 古い runtime 状態を現在事実のように扱っている

この場合は、EpisodeCard として採用せず、raw audit log または低信頼候補として扱う。

## データモデル素案

将来の実装では、概念的には次の分離を持つ。

```text
episode_cards
  id
  title
  situation
  observations
  action
  outcome
  lesson
  applicability
  anti_applicability
  confidence
  domains
  technologies
  change_types
  created_at
  updated_at

episode_refs
  id
  episode_card_id
  ref_kind
  ref_value
  query_hint
  metadata
  created_at

episode_retrieval_feedback
  id
  episode_card_id
  ref_id
  retrieval_reason
  used_for
  outcome
  created_at
```

このモデルは確定 schema ではない。実装時は既存の audit、vibe memory、compile/decision run history、Knowledge repository との境界を確認する。

## MCP 境界

context-still は MCP-first の外部 capability として扱う。

外部 agent や別プロジェクトが Episode 記憶を利用する場合でも、専用 client、repository、schema、fallback を相手側に追加するのではなく、MCP tool 経由で optional に使う。

想定される surface:

- `context_compile` が EpisodeCard を retrieval source として使う
- `context_decision` が EpisodeCard を conditional precedent として使う
- `search_memory` / `fetch_memory` が raw history または EpisodeCard drill down を担う
- `register_candidates` が蒸留された Rule / Procedure を登録する

## 非目標

- raw log を毎回 LLM context に入れること
- EpisodeCard を唯一の真実にすること
- vector search だけで「似ている」と確定すること
- 過去 Episode だけで decision を自動決定すること
- Headroom をそのまま runtime dependency として導入すること
- 既存 agent 側に context-still 専用依存を追加すること

## 将来の実装 slice

### Slice 0: Concept And Evaluation Fixtures

- この文書を baseline として残す
- 既存の vibe memory / audit log / compile runs から手作業で EpisodeCard 例を数件作る
- compile と decision で人間が見て有用かを評価する

### Slice 1: EpisodeCard Projection

- audit log または vibe memory から EpisodeCard を生成する projection を作る
- Ref を必ず付ける
- raw log は context に入れず、Card だけを通常参照にする

### Slice 2: Hybrid Retrieval

- vector search と full-text search を組み合わせる
- `domains` / `technologies` / `changeTypes` / outcome で filter する
- applicability rerank を入れる

### Slice 3: compile / decision Integration

- `context_compile` の pack に EpisodeCard section を追加する
- `context_decision` では EpisodeCard を conditional precedent として扱う
- 根拠不足時だけ Ref drill down できるようにする

### Slice 4: Retrieval Feedback And Distillation

- どの Ref が取得されたかを feedback として保存する
- よく retrieve される evidence pattern を EpisodeCard の ranking に反映する
- 複数 Episode から Rule / Procedure 候補を作る

## 未解決事項

- EpisodeCard を自動生成するか、on-demand 生成するか。
- Card の更新をどのタイミングで行うか。
- raw audit log の retention policy。
- Ref の stable identity を既存 audit schema で十分に表現できるか。
- `vibe_memories` と EpisodeCard を同じ storage に置くか、projection として分けるか。
- decision で EpisodeCard を採用する confidence threshold。
- EpisodeCard が古くなった時の invalidation と warning。

## 判断基準

この構想が成功している状態:

- 普段の context は EpisodeCard だけで足りる
- 詳細が必要な時だけ Ref で元証拠へ戻れる
- compile は過去事例から作業地図を改善できる
- decision は過去事例を条件付き precedent として使える
- raw log を直接 context に入れる頻度が下がる
- 何が要約され、何が原本に残っているかを人間が追える

失敗している状態:

- EpisodeCard がただの作業日誌になっている
- Ref がなく検証できない
- 類似検索が vector similarity だけで決まっている
- decision が過去事例を過信している
- raw log を毎回展開して context が肥大化している
- 人間が Card と log の関係を追えない
