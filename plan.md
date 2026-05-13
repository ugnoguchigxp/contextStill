# memory-router plan

調査日: 2026-05-13

## 位置づけ

`memory-router` は、将来的に `gnosis` へ統合または改名する前提の一時プロジェクト名である。

このプロジェクトの中核は、単なるメモリ保存ではない。LLM エージェントが作業を始める直前に、過去の記憶、ルール、スキル、事例、コード構造、証拠ログを選別し、最小限の実行用コンテキストへまとめる **Context Compiler** を作ることにある。

目標は「記憶をたくさん持つ」ことではなく、エージェントが次の行動で失敗しにくくなる context pack を作ること。

この文書は全体の方向性を示す構想書であり、個別の実装順序や作業手順は `docs/` 以下の実装計画に分けて管理する。急いで薄い MVP を作るより、ドメイン境界、データ定義、検索品質、運用検証を一つずつ十分な完成度で積み上げる。

## 背景調査

### GitNexus

参考: https://github.com/abhigyanpatwari/GitNexus

GitNexus は、コードベースを knowledge graph として index し、依存関係、call chain、cluster、execution flow、blast radius を事前計算して MCP tools から返す。

重要な学び:

- Coding agent には、曖昧な vector 検索だけではなく、AST / dependency / call graph / impact analysis のような構造化された context が効く。
- LLM に生の graph edge を探索させるより、index 時点で意味のある構造へまとめておく方が token 効率と信頼性が高い。
- Web UI よりも CLI + MCP が日常利用の本命になっている。

memory-router への示唆:

- コード記憶は Markdown や会話ログとは別に、構造 index として扱う。
- Context Compile は、ただ関連文書を返すのではなく、影響範囲、主要ファイル、関係、リスクを事前構造化して返すべき。

### Hermes Agent

参考: https://github.com/nousresearch/hermes-agent
参考: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md
参考: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md

Hermes は bounded memory、session search、skills を分けている。常時注入される memory は小さく制限され、過去会話は FTS5 search、手順知識は SKILL.md として on-demand に読む。

重要な学び:

- 常時 memory は小さいほどよい。肥大化した MEMORY.md は prefix cache と注意配分を壊す。
- Memory は factual knowledge、Skill は procedural knowledge と分けるのが合理的。
- Skills は使われた結果で更新され、stale なものは curator により管理される。

memory-router への示唆:

- 常時 context、検索される記憶、on-demand skill を分離する。
- Skill / rule / procedure は本文ログから自動注入せず、明示的な lifecycle を持たせる。
- Memory Router は、記憶本体よりも「何を今読むべきか」を決める役割に寄せる。

### Ruflo

参考: https://github.com/ruvnet/ruflo

Ruflo は multi-agent orchestration、hooks、self-learning memory、swarm、plugin marketplace を強く打ち出している。

重要な学び:

- hooks によって、ユーザーが意識しなくても memory / learning / routing が動く設計は有効。
- 一方で、agent 数、command 数、plugin 数が多くなると OSS として理解・導入・検証が難しくなる。

memory-router への示唆:

- 初期 OSS としては大きな orchestration platform を目指さない。
- 最初の価値は `pre-task context compile` に絞る。
- hooks は後段で有効だが、初期の中核 API は小さく保つ。

### Codex / AGENTS.md / MEMORY.md

参考: https://www.mintlify.com/openai/codex/features/memory

Codex 型の AGENTS.md は、単純だが強い。プロジェクト固有のルールが起動時に読まれるため、低コストで agent の行動を補正できる。

重要な学び:

- 常時読まれる instruction は、短く、具体的で、更新しやすいほど効く。
- 巨大な AGENTS.md は逆効果になりうる。
- ディレクトリ階層ごとの instruction は有効だが、適用範囲と優先順位が重要。

memory-router への示唆:

- AGENTS.md を置き換えるより、AGENTS.md を生成・補助・検証する立場がよい。
- Context Compiler は、常時 instruction と task-specific context を分けて出力する。

### OpenAI Agents SDK memory

参考: https://openai.github.io/openai-agents-js/guides/sandbox-agents/memory/
参考: https://openai.github.io/openai-agents-js/guides/sessions/

OpenAI Agents SDK の memory は progressive disclosure に寄っている。最初に小さな `memory_summary.md` を注入し、必要なら MEMORY.md、さらに必要なら rollout summaries を読む。

重要な学び:

- 最初から全記憶を注入しない。
- Session memory と cross-session memory は別物。
- Memory generation は conversation extraction と layout consolidation に分けられている。

memory-router への示唆:

- context pack は段階的に作る。
- fast path は metadata / FTS / vector / cached summary で短時間に出す。
- deep path は LLM に再ランキングや圧縮をさせるが、同期必須にはしない。

### LangGraph memory

参考: https://docs.langchain.com/oss/python/concepts/memory

LangGraph は memory を short-term / long-term に分け、long-term を semantic / episodic / procedural に整理している。

重要な学び:

- Semantic memory: facts, concepts, user/project profile
- Episodic memory: past actions and task examples
- Procedural memory: instructions, skills, policies
- Memory writing は hot path と background の tradeoff がある。

memory-router への示唆:

- Memory item の `type` は設計の中心になる。
- coding agent で最も効くのは procedural memory と structural memory。
- episodic memory は直接注入せず、事例・証拠として必要時に引く。

### Microsoft GraphRAG

参考: https://microsoft.github.io/graphrag/query/overview/

GraphRAG は local search、global search、DRIFT search、basic vector search を分けている。

重要な学び:

- 問いの種類によって retrieval mode を変えるべき。
- entity 周辺を深く見る local search と、全体傾向を見る global search は別物。
- Graph と raw text chunk を組み合わせることで回答品質を上げる。

memory-router への示唆:

- Context Compiler も retrieval mode を持つべき。
- `task_context`, `review_context`, `debug_context`, `architecture_context`, `learning_context` のような mode が必要。

### Agent memory research

参考: https://arxiv.org/abs/2603.07670
参考: https://arxiv.org/abs/2512.12818

2026 年時点の agent memory 研究では、memory は単なる vector store ではなく、write / manage / read loop として扱われている。Hindsight は evidence と inference を分け、world facts、agent experiences、entity summaries、beliefs のような logical networks として memory を扱う。

重要な学び:

- 証拠と推論を混ぜると、誤った記憶が正本化される。
- long-horizon agent には retain / recall / reflect の分離が必要。
- contradiction handling、forgetting、privacy、latency budget は実装上の中核課題である。

memory-router への示唆:

- `source evidence` と `distilled knowledge` を同じものとして扱わない。
- context pack には必ず evidence_refs を残す。
- LLM が一度言ったことを自動で active memory にしない。

## 中核コンセプト

### 一文説明

`memory-router` is a local-first context compiler for coding agents. It routes memories, rules, skills, examples, and code intelligence into the smallest useful context pack before an agent acts.

### 解く問題

LLM agent は stateless であり、毎回次の問題を抱える。

- プロジェクト固有ルールを忘れる
- 過去に失敗した手順を繰り返す
- 関係するファイルや依存を見落とす
- 過去の会話ログを直接読ませるとノイズが多すぎる
- vector search だけでは、適用条件や信頼度が弱い
- AGENTS.md を肥大化させると常時 context が汚れる

memory-router は、これらを「保存」ではなく「実行直前の context compile」で解決する。

### 基本思想

- Store everything, inject little.
- Evidence is not instruction.
- Skills beat summaries for action.
- Graph explains relationships; text explains details.
- Vector search is a recall aid, not truth.
- AGENTS.md should stay small.
- Context should be compiled per task, not globally dumped.

## 記憶モデルとデータ境界

memory-router は、既存 Gnosis のデータ資産を継承することを前提にしない。再利用してよいのは、Gnosis 開発環境で使っていた pgvector 対応 PostgreSQL container であり、既存 table の中身は空にしてもよい。

データ定義はゼロベースで設計してよい。既存 Gnosis の `entities`、`relations`、`vibe_memories`、`experience_logs` は参考実装または後段の importer の移植元として扱うが、新設計を既存 schema に無理に合わせない。

### Conceptual item types

初期設計では、少なくとも以下の型を想定する。

- `fact`: 事実、環境情報、設定
- `decision`: 設計判断、ADR
- `rule`: 守るべき制約
- `procedure`: 手順
- `skill`: 複数ステップの実行知識
- `risk`: 失敗しやすい点、注意点
- `example`: 過去の成功・失敗事例
- `episode`: 会話やタスク実行の履歴
- `code_symbol`: 関数、クラス、モジュールなどの構造情報
- `source`: Web、docs、issue、commit、wiki page、session log、tool output などの証拠元

ただし、これらを単一 table に押し込むとは限らない。特に instruction と evidence と code index は役割が違うため、物理モデルでは分ける。

### Physical domains

初期の物理データモデルは、以下の責務分離を基本にする。

- `knowledge_items`: rule / decision / procedure / skill / risk / lesson / fact / example など、agent の判断材料になる蒸留済み知識。
- `evidence_sources`: session log、Markdown、Web、tool output、commit、diff、外部文書などの証拠元。
- `evidence_fragments`: source 内の参照可能な範囲。context pack には raw source 全体ではなく fragment を引用する。
- `relations`: knowledge、evidence、code symbol、task run 間の関係。
- `code_symbols`: repository から抽出した file / module / function / class / import / export などの構造 index。
- `context_compile_runs`: context compile の入力、選択結果、degraded state、品質評価の実行履歴。
- `context_pack_items`: pack に採用された item、採用理由、score、evidence refs。

### Common fields

```yaml
id: string
type: fact | decision | rule | procedure | skill | risk | example | episode | code_symbol | source
title: string
body: string
scope: user | repo | workspace | org | global
source_kind: manual | markdown | session | code_index | web | generated
status: candidate | draft | trial | active | deprecated | rejected
evidence_refs: string[]
applies_to:
  repos: string[]
  paths: string[]
  languages: string[]
  frameworks: string[]
  change_types: string[]
confidence: number
importance: number
created_at: string
updated_at: string
last_verified_at: string | null
```

### Lifecycle

```text
source
  -> candidate
  -> draft
  -> trial
  -> active
  -> deprecated / rejected
```

重要なのは、未検証の候補を LLM の行動規範にしないこと。

`candidate` と `draft` は UI / CLI で見えるが、通常の context pack には入れない。`trial` は明示的に許可された場合だけ入れる。`active` だけが通常注入対象になる。

## Context Compiler

### 役割

Context Compiler は、ユーザー要求や hook 入力を受け取り、agent が次に実行するための context pack を作る。

```text
User request / diff / file path / command
  -> intent classification
  -> retrieval mode selection
  -> memory routing
  -> ranking / dedupe
  -> context pack generation
```

### Context pack 例

```yaml
goal: "Implement graph relation API"
intent: "edit"
task_type: "backend-api"
minimal_tasks:
  - inspect current page/link schema
  - add derived graph relation read API
  - add focused tests
rules:
  - id: rule.markdown-source-of-truth
    text: "Markdown/frontmatter remains the source of truth."
skills:
  - id: skill.pgvector-derived-index
    title: "Maintain Postgres / pgvector derived indexes"
examples:
  - id: example.session-distillation-approval
    why: "Similar candidate -> approval -> active lifecycle"
code_context:
  files:
    - apps/api/src/lib/indexing.ts
    - apps/api/src/routes/pages.ts
warnings:
  - "Do not build a full editor in the first slice."
evidence_refs:
  - wiki:docs/knowledge-graph.md
  - session:2026-05-02T...
```

### Retrieval modes

初期候補:

- `task_context`: 実装前の最小 context
- `review_context`: review 前の rules / risks / examples
- `debug_context`: 失敗ログ、既知の修正、関連コード
- `architecture_context`: 設計判断、関連 wiki、依存 graph
- `skill_context`: 手順・コマンド・検証方法
- `learning_context`: 候補抽出・蒸留・skill 化

## アーキテクチャ方針

### 入力

- Markdown vault
- AGENTS.md / CLAUDE.md / project docs
- Git repository
- session logs
- task runs
- tool outputs
- Web / external docs

### 内部

- PostgreSQL / pgvector store
- knowledge item store
- evidence store
- relation graph
- Postgres full-text / exact search index
- pgvector semantic index
- code structure index
- context compiler
- lifecycle manager

### 出力

- MCP tool: `context_compile`
- MCP resources: memory summaries, available packs, graph slices
- CLI: `memory-router compile "..."`
- AGENTS.md / SKILL.md generation
- JSON context pack
- Markdown context preview
- UI for approval, graph, health, audit

## Storage 方針

正本と派生 index を分ける。

- Markdown: 人間向けの正本。wiki、ADR、rules、docs。
- PostgreSQL: operational memory、status、task runs、relations、context compile 履歴。
- pgvector: semantic recall。vector search は recall aid であり、truth source ではない。
- Postgres full-text / exact search: error messages、file names、commands、symbol names、known rules の確実な検索。
- Graph tables: relation、lineage、source、validation、impact path。
- HTML: viewer cache。正本にしない。

開発初期は Gnosis で使っていた `pgvector/pgvector` container を流用してよい。ただし、既存 Gnosis データは保持対象ではなく、必要なら DB / schema を破棄して空の状態から開始する。安全のため、memory-router 用 database または schema を分けることを優先する。

移行は初期目標にしない。将来必要になった場合だけ、既存 Gnosis や wiki から importer / seed として取り込む。

## LLM 利用方針

LLM は memory system の中心ではなく、候補生成・分類・圧縮・rerank の補助に使う。

### Fast path

- metadata filter
- FTS
- vector search
- graph neighborhood
- cached summaries

目標: 1-3 秒で context pack を返す。

### Deep path

- Gemma4 / OpenAI による再ランキング
- candidate extraction
- skill draft generation
- contradiction detection
- context pack quality check

目標: 非同期または明示実行。同期必須にしない。

## UI 方針

UI は本文エディタではなく、control plane に寄せる。

初期画面候補:

- Context Pack Preview
- Memory Inbox
- Active Rules / Skills
- Evidence Viewer
- Graph Explorer
- Runs / Usage
- Doctor / Index Freshness

Markdown 本文は read-only viewer で十分。編集は Obsidian や通常エディタに任せる。

## OSS としての価値

このプロジェクトは、既存 memory store や vector DB と競合しない。

差別化ポイント:

- Agent が作業する直前の context compile に集中する。
- Memory、skills、rules、examples、code intelligence を一つの context pack にまとめる。
- Evidence と instruction を分ける。
- AGENTS.md を巨大化させず、on-demand context に逃がす。
- MCP / CLI / hooks から使える。
- Local-first で、既存 repo / markdown / session log に載せやすい。

## 非目標

初期段階では以下をやらない。

- フル Wiki editor
- 汎用 multi-agent swarm
- review agent の完成
- vector DB だけで memory を完結させること
- LLM の自動判断だけで active memory を作ること
- AGENTS.md の全面置換
- Cloud SaaS 前提の設計

## 段階的実装方針

薄い MVP を急がない。最初の段階では、全体の理想像から切り出した一つの capability を、schema、repository、service、CLI/MCP、テスト、運用診断まで含めて確実に作る。

最初に手掛ける候補:

1. Repository skeleton
2. PostgreSQL / pgvector container 設定
3. ゼロベースの domain schema
4. Drizzle migration
5. Zod shared schemas
6. domain 別 repository / service
7. Markdown source importer
8. `context_compile` core function
9. CLI command
10. MCP tool
11. Context pack preview output
12. focused tests / doctor

Graph UI、graph traversal、Gemma4 integration、Obsidian adapter は第 2 段階でよい。pgvector による semantic recall は基盤として最初から想定するが、LLM rerank や高度な graph 検索は急がない。

## 判断メモ

- 一時 repo 名は `memory-router`。
- 将来的な最終名は `gnosis` にする可能性が高い。
- 旧 `gnosis` repo は当面残し、使える部品の移植元として扱う。ただし、既存 DB データや schema の互換継承は必須ではない。
- Gnosis で使っていた pgvector 対応 PostgreSQL container は流用してよい。中身は空にしてよく、memory-router 用の database / schema を新設する。
- 現 `wiki` repo は Obsidian / Markdown / graph viewer の実験には使えるが、OSS 中核は `memory-router` として別 repo にする。

## 次回やること

実装計画は `docs/` 以下で個別に管理する。

決めるべきこと:

- package manager / runtime
- TypeScript project 構成
- PostgreSQL / pgvector schema
- memory item JSON schema
- context pack schema
- CLI command set
- MCP tool surface
- web server / control plane API の要否
- first tests
- old gnosis から移植する候補一覧。ただし既存データ移行は初期必須にしない。
- wiki repo から移植または参照する候補一覧
