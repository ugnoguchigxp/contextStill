# Git History Episode Candidate Plan

Status: draft
Created: 2026-06-07
Owner: ContextStill knowledge / Distillation

## Purpose

会話由来の Vibe Memory 蒸留だけでは拾いにくい、ソースコードの変更遍歴から見える設計成熟の episode を候補化する。

この計画の主語は `git diff` 全体の要約ではない。主語は、ファイル単位またはドメイン単位で「元のロジックや構造がこうだったが、後続の変更でこうなった。最初はこの考慮が足りていなかった」という再利用可能な学習候補を抽出することである。

LocalLLM に git 探索を任せない。LLM は探索者ではなく、決定的な前処理で作った episode 候補の意味づけ・再ランキング・既存 knowledge との関係判定に限定する。

## Decision

git 履歴由来の候補生成を、会話蒸留とは別の補助入力として追加する。

- commit 全体を読むのではなく、ファイル単位またはドメイン単位の変更遍歴を見る。
- raw diff 全文を LocalLLM に渡さない。
- git 操作、履歴探索、対象拡張は deterministic な collector / prefilter が行う。
- LocalLLM は前処理済み候補に対して `before / pressure / after / lesson` を推定する。
- 最終的な知識登録は、既存 knowledge 検索との照合後に行う。
- 初期実装では `rule` / `procedure` または `symptom-cause-fix` に昇格できる候補だけを扱う。

## Non-Goals

- 会話全文 + git diff 全文を統合して蒸留しない。
- commit message だけから knowledge を生成しない。
- git 操作ログから knowledge を生成しない。
- LocalLLM に `git log` / `git show` の探索計画を作らせない。
- 全 repository の履歴を無制限に読む機能にしない。
- 単発 diff の説明を episode とみなさない。
- 低重要度候補をそのまま active knowledge にしない。

## Vocabulary

- Domain: `src/modules/vibe-memory/**`、`src/modules/distillationTarget/**`、`src/modules/doctor/**` のような意味上の変更単位。
- File history: 1ファイルの `git log --follow -- <path>` 相当の履歴。
- Episode: 変更遍歴から見える、before / pressure / after / lesson を持つ候補。
- Frontier candidate: deterministic prefilter が作る、LLM に渡してよい候補。
- Key hunk: episode の説明に必要な最小差分。raw diff 全文ではない。
- Current shape: 現在の実装構造。変更遍歴だけでなく最終形を読むための補助情報。

## Source Model

対象は commit ではなく domain / file である。

```ts
type GitHistorySourceScope =
  | { kind: "domain"; key: string; paths: string[] }
  | { kind: "file"; path: string };
```

履歴収集は次の順で行う。

1. 明示された domain / file を受け取る。
2. 対象 path だけで `git log --name-status --date=iso -- <paths>` を取得する。
3. file 単位で commit timeline を作る。
4. 必要な commit だけ `git show --unified=<small>` で key hunk を取得する。
5. 現在の file shape を必要最小限だけ読む。

LLM はこの探索順を変更できない。

## Deterministic Signals

prefilter は単純な signal を使う。意味推論はしない。

| Signal | Meaning | Example |
|---|---|---|
| repeated_modification | 同一 file/domain が短期間に複数回修正された | 7日以内に3回以上 |
| fix_after_feature | feature 後に fix/regression/test が続く | `feat` -> `fix` |
| test_added_later | 実装後に test が追加された | `test/**` or `*.test.ts` |
| schema_or_contract_change | schema/API/DB contract が後から変わった | `schema`, `routes`, `repository` |
| boundary_split | service/repository/runtime/policy へ責務が分かれた | file 増加、import 変化 |
| fallback_removed | fallback/heuristic が削除または明示 error に変わった | `fallback`, `status`, `error` |
| traceability_added | metadata/source/runId/inputHash 等が追加された | `metadata`, `sourceUri`, `runId` |
| verification_added | verify/test/doctor/check が後から追加された | `doctor`, `verify`, `assert` |
| ui_backend_alignment | UI だけでなく backend/storage も同時に変わった | `web/**` + `src/modules/**` |

初期スコア例:

```ts
type GitHistorySignalScore = {
  repeatedModification: number;
  fixAfterFeature: number;
  testAddedLater: number;
  schemaOrContractChange: number;
  boundarySplit: number;
  fallbackRemoved: number;
  traceabilityAdded: number;
  verificationAdded: number;
  uiBackendAlignment: number;
};
```

合計点が閾値未満の履歴は LLM に渡さない。

## Episode Windowing

commit 単位ではなく、file/domain timeline を window にまとめる。

Window 条件:

- 同一 file または同一 domain に属する。
- 時間的に近い。初期値は 14 日以内。
- 変更 signal が連続している。
- `feature -> fix -> test`、`implementation -> contract update -> verification` のような流れがある。

Window は広げすぎない。初期上限:

- 最大 commit 数: 8
- 最大 file 数: 12
- 最大 key hunk 数: 20
- 最大入力文字数: LocalLLM の実運用 context budget に合わせて設定する。

## Candidate Shape

prefilter が作る frontier candidate は、LLM にそのまま渡せる構造にする。

```ts
type GitHistoryEpisodeCandidate = {
  id: string;
  sourceKind: "git_history_episode";
  scope: GitHistorySourceScope;
  timeRange: {
    fromCommit: string;
    toCommit: string;
    fromDate: string;
    toDate: string;
  };
  files: string[];
  commits: Array<{
    sha: string;
    date: string;
    message: string;
    changedFiles: string[];
    signals: string[];
  }>;
  deterministicSummary: {
    changedLayers: string[];
    addedTests: string[];
    contractFiles: string[];
    removedFallbackHints: string[];
    traceabilityHints: string[];
  };
  keyHunks: Array<{
    commit: string;
    file: string;
    changeType: "add" | "modify" | "delete" | "rename";
    hunk: string;
  }>;
  currentShapeRefs: Array<{
    file: string;
    summary: string;
  }>;
  score: number;
  signals: string[];
};
```

## LLM Role

LLM の入力は frontier candidate のみ。

LLM に求める出力:

```ts
type GitHistoryEpisodeJudgement = {
  decision: "promote_candidate" | "attach_evidence" | "skip";
  relationshipHint: "novel" | "refinement" | "duplicate" | "evidence" | "noise";
  episode: {
    before: string;
    pressure: string;
    after: string;
    lesson: string;
  } | null;
  suggestedKnowledgeShape: "rule" | "procedure" | "symptom-cause-fix" | "evidence" | "none";
  confidence: "low" | "medium" | "high";
  reasons: string[];
  riskNotes: string[];
};
```

LLM に禁止すること:

- 追加の git command を要求する。
- 対象外 file を読むよう提案する。
- diff から読めない意図を断定する。
- 既存 knowledge 検索なしに新規登録を確定する。

## Knowledge Adjudication

LLM judgement の後に、既存 knowledge 検索を必ず挟む。

判定:

- `novel`: 既存 knowledge では表現できない episode。新規候補にする。
- `refinement`: 既存 knowledge の条件、検証、avoid に追加価値がある。更新候補または evidence にする。
- `duplicate`: 既存 knowledge で十分。登録しない。
- `evidence`: 新規知識ではないが、既存 knowledge の根拠になる。source/origin link 候補にする。
- `noise`: 文脈依存または単発。破棄する。

登録時の表現は blame ではなく構造変化として書く。

```text
この構造では X の区別が表現できなかったため、後に Y の境界が導入された。
同種の実装では、最初に Z を検証する。
```

## Initial Target Domains

初期対象は、履歴から episode が出やすく、既存の候補選出/知識化と関係が深い領域に限定する。

1. `src/modules/vibe-memory/**`
   - raw agent log memory、agent diff entries、distillation input の境界。
2. `src/modules/findCandidate/**`
   - 候補選出、reader、LLM 判定、queue 連携。
3. `src/modules/distillationTarget/**`
   - target state、priority、inventory、repair。
4. `src/modules/doctor/**` and `src/shared/doctor/**`
   - measured/inferred のラベル、診断理由、admin 表示。
5. `src/modules/context-compiler/**`
   - retrieval、compile result、evaluation 連携。

初期実装では repository 全体 scan はしない。

## Phased Plan

### Phase 0: History Inventory

Goal: 対象 domain の履歴量と signal 分布を把握する。

Tasks:

- [ ] domain path 定義を作る。
- [ ] `git log --name-status --date=iso -- <paths>` を取得する CLI smoke を作る。
- [ ] file ごとの commit count、期間、変更種別を出す。
- [ ] signal 候補を集計だけ行い、LLM は呼ばない。
- [ ] 上位 domain/file が妥当か人間が確認する。

Verification:

- [ ] `vibe-memory` / `findCandidate` / `distillationTarget` の履歴が取得できる。
- [ ] 0 件 domain と大量 domain が区別できる。
- [ ] 出力が deterministic で、同じ HEAD なら同じ結果になる。

### Phase 1: Deterministic Frontier Builder

Goal: LLM に渡す前の episode 候補を作る。

Tasks:

- [ ] timeline windowing を実装する。
- [ ] signal scoring を実装する。
- [ ] key hunk 抽出を小さい unified diff に制限する。
- [ ] current shape refs を最小化する。
- [ ] frontier candidate JSON を出力する。
- [ ] token/char budget 超過時は hunk を落とし、candidate 自体は保持する。

Verification:

- [ ] LocalLLM を使わず frontier candidates が作れる。
- [ ] raw diff 全文が出力されない。
- [ ] top candidates の理由が signal として説明できる。
- [ ] file/domain 外の履歴が混入しない。

### Phase 2: LLM Episode Judgement

Goal: frontier candidate を episode 候補として意味づけする。

Tasks:

- [ ] prompt は `before / pressure / after / lesson` に固定する。
- [ ] 出力 schema を固定する。
- [ ] `decision = skip` を許容する。
- [ ] confidence が low の候補は昇格対象にしない。
- [ ] LocalLLM 失敗時は candidate を保留し、fallback 生成しない。

Verification:

- [ ] LLM が追加探索を要求しても無視できる。
- [ ] diff から読めない意図断定が `riskNotes` に落ちる。
- [ ] low confidence は登録候補にならない。

### Phase 3: Existing Knowledge Match

Goal: episode 候補を既存 knowledge と照合し、新規登録を抑制する。

Tasks:

- [ ] episode.lesson / before / after から検索 query を作る。
- [ ] `search_knowledge` 相当の既存検索を呼ぶ。
- [ ] `novel / refinement / duplicate / evidence / noise` を判定する。
- [ ] duplicate は破棄または evidence へ落とす。
- [ ] refinement は既存 knowledge の更新候補として扱う。

Verification:

- [ ] 既存 knowledge と近い候補が新規重複登録されない。
- [ ] matchedKnowledgeIds が保持される。
- [ ] judgement と search result の根拠が review できる。

### Phase 4: Review Queue Integration

Goal: 自動 active 化せず、候補 review に流す。

Tasks:

- [ ] `sourceKind = git_history_episode` を candidate source として扱う。
- [ ] source refs に commit sha、file path、hunk locator を残す。
- [ ] UI/API で source が会話由来か git 履歴由来か区別できるようにする。
- [ ] review item から key hunks と current shape refs を確認できるようにする。

Verification:

- [ ] git 履歴由来候補が draft/review 状態で止まる。
- [ ] source refs から該当 file/commit を追える。
- [ ] 会話由来候補と混同されない。

### Phase 5: Evaluation

Goal: 会話由来候補に対する補完価値を測る。

Metrics:

- frontier candidates count
- LLM promoted count
- skipped by low confidence
- duplicate rate against existing knowledge
- accepted review rate
- later `context_compile` selection rate
- evidence-only conversion rate

Evaluation questions:

- 会話由来では出なかった実装構造の lesson が出たか。
- 重複候補が増えすぎていないか。
- LocalLLM の入力サイズは安定しているか。
- review cost に見合う accepted candidate があるか。

## Implementation Notes

Git command は固定する。

```bash
git log --name-status --date=iso --format=%H%x09%ad%x09%s -- <paths>
git show --format= --unified=3 -- <sha> -- <paths>
```

rename 対応が必要な file history では、file 単位のみ `--follow` を使う。domain 単位では `--follow` を使わない。

差分の parsing は最初は完全 AST 化しない。file path、hunk header、追加/削除行、キーワード signal の抽出に限定する。

## Risks

| Risk | Mitigation |
|---|---|
| LocalLLM が意図を過剰推定する | `riskNotes` と confidence gate を必須にする |
| raw diff が大きすぎる | key hunk 抽出と char budget を前処理で強制する |
| 重複 knowledge が増える | 既存 knowledge match を登録前に必須化する |
| commit の物語に寄りすぎる | file/domain timeline を主語にする |
| 低価値候補が queue を汚す | deterministic score threshold と review metrics で削る |
| source refs が追えない | commit sha、file path、hunk locator を必須にする |

## Open Questions

- domain 定義は設定ファイル化するか、初期はコード内定義にするか。
- episode window の期間初期値は 7 日か 14 日か。
- key hunk の最大数と最大文字数をどこに置くか。
- `git_history_episode` を既存 `distillation_candidates.source_kind` に追加するか、finding queue の source metadata に閉じるか。
- review UI に key hunk を表示するか、まず JSON/CLI 出力だけにするか。

## Acceptance Criteria

- LocalLLM に git 探索を任せず、frontier candidate を deterministic に生成できる。
- 少なくとも 1 domain で、file/domain 変更遍歴から episode 候補を出せる。
- 候補には before / pressure / after / lesson を保持できる。
- 既存 knowledge 検索を通して duplicate を抑制できる。
- 自動 active 化せず review 可能な状態で止められる。
- 同じ HEAD と同じ設定なら同じ frontier candidate が再生成される。
